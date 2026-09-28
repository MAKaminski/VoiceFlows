import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectImport, ident, importSummary, parseImport, parseOpenApi, parsePackage, parsePrisma, parseSql, safeLabel } from "../src/importers.js";

/** Bring your systems (ADR 0022): parsers are pure, bounded, and sanitise every name at the boundary. */
const own = readFileSync(resolve(import.meta.dirname, "../../../db/schema.sql"), "utf8");

describe("SQL import", () => {
  it("reads our own schema: 17 tables, every FK a relation, pk/fk marked", () => {
    const i = parseSql(own);
    expect(i.tables).toHaveLength(17);
    // Every REFERENCES in the file, as distinct non-self table pairs.
    const pairs = new Set<string>();
    for (const t of own.split(/CREATE TABLE /).slice(1)) {
      const name = t.split(/\s/)[0]!;
      for (const m of t.matchAll(/REFERENCES (\w+)/g)) if (m[1] !== name) pairs.add([m[1], name].sort().join("|"));
    }
    expect(i.relations.length).toBe(pairs.size);
    const versions = i.tables.find((t) => t.name === "design_versions")!;
    expect(versions.cols).toEqual(expect.arrayContaining(["id:uuid:pk"]));
    expect(versions.cols.some((c) => /^document_id:uuid:fk$/.test(c))).toBe(true);
  });
  it("handles pg_dump style: quoted names, schema prefix, ALTER TABLE … FOREIGN KEY, numeric(10,2)", () => {
    const i = parseSql(`
      CREATE TABLE public."Orders" ( "Id" uuid NOT NULL, "CustomerId" uuid, total numeric(10,2) DEFAULT 0, note character varying(255) );
      CREATE TABLE public.customers ( id uuid NOT NULL, email text );
      ALTER TABLE ONLY public."Orders" ADD CONSTRAINT orders_pkey PRIMARY KEY ("Id");
      ALTER TABLE ONLY public."Orders" ADD CONSTRAINT fk FOREIGN KEY ("CustomerId") REFERENCES public.customers(id);`);
    const orders = i.tables.find((t) => t.name === "orders")!;
    expect(orders.cols).toEqual(["id:uuid:pk", "customer_id:uuid:fk", "total:numeric", "note:text"]);
    expect(i.relations).toEqual([{ one: "customers", many: "orders" }]);
  });
});

describe("Prisma / OpenAPI / package.json import", () => {
  it("Prisma: models → tables, @relation fields → relations, fk columns marked", () => {
    const i = parsePrisma(`datasource db { provider = "postgresql" }
      model User {
        id    String @id @default(uuid())
        email String @unique
        posts Post[]
      }
      model Post {
        id        Int      @id
        title     String
        author    User     @relation(fields: [authorId], references: [id])
        authorId  String
        createdAt DateTime
        @@index([authorId])
      }`);
    expect(i.tables.map((t) => t.name)).toEqual(["user", "post"]);
    expect(i.tables[1]!.cols).toEqual(["id:int:pk", "title:text", "author_id:text:fk", "created_at:timestamptz"]);
    expect(i.relations).toEqual([{ one: "user", many: "post" }]);
  });
  it("OpenAPI: schemas → tables ($ref → fk + relation), title → the API component", () => {
    const i = parseOpenApi({ openapi: "3.0.0", info: { title: "Support API" }, paths: {},
      components: { schemas: { Case: { type: "object", properties: { id: { type: "string", format: "uuid" }, subject: { type: "string" }, customer: { $ref: "#/components/schemas/Customer" }, opened: { type: "string", format: "date-time" } } }, Customer: { properties: { id: { type: "string" }, cases: { type: "array", items: { $ref: "#/components/schemas/Case" } } } } } } });
    expect(i.tables.find((t) => t.name === "case")!.cols).toEqual(["id:uuid:pk", "subject:text", "customer_id:uuid:fk", "opened:timestamptz"]);
    expect(i.relations).toEqual([{ one: "customer", many: "case" }]); // the array side is the same pair — deduped
    expect(i.components.map((c) => c.label)).toEqual(["Client", "Support API", "Database"]);
  });
  it("package.json: known dependencies → components and flows", () => {
    const i = parsePackage({ dependencies: { next: "15", fastify: "5", pg: "8", ioredis: "5", stripe: "14", "@sendgrid/mail": "8", lodash: "4" } });
    expect(i.components.map((c) => c.label)).toEqual(["Web app", "API", "Postgres", "Redis", "Stripe", "SendGrid"]);
    expect(i.flows).toEqual(expect.arrayContaining([{ from: "Web app", to: "API", label: "calls" }, { from: "API", to: "Postgres", label: "writes to" }]));
  });
  it("detects the kind", () => {
    expect(detectImport(own)).toBe("sql");
    expect(detectImport(`{"openapi":"3.1.0"}`)).toBe("openapi");
    expect(detectImport(`{"name":"x","dependencies":{}}`)).toBe("package");
    expect(detectImport(`model A { id Int @id }`)).toBe("prisma");
    expect(detectImport("hello")).toBeNull();
    expect(importSummary(parseImport(own)!)).toMatch(/^17 tables, \d+ relations → ERD$/);
  });
});

describe("hostile input (plan-critic M10 #6)", () => {
  it("names that try to break out become plain identifiers", () => {
    const i = parseSql(`CREATE TABLE "x\"); process.exit(1); //" ( "a\nb" text, "cols=evil" int );`);
    for (const t of i.tables) { expect(t.name).toMatch(/^[a-z_][a-z0-9_]{0,62}$/); for (const c of t.cols) expect(c).toMatch(/^[a-z_][a-z0-9_]*:[a-z0-9_]+(:pk|:fk)?$/); }
    expect(ident("1; DROP TABLE")).toBe("drop_table");
    expect(safeLabel('Evil" >root k=x "')).toBe("Evil root k x");
  });
  it("caps what one import can add", () => {
    const sql = Array.from({ length: 80 }, (_, n) => `CREATE TABLE t${n} (id int);`).join("\n");
    const i = parseSql(sql);
    expect(i.tables).toHaveLength(60);
    expect(i.dropped).toBe(20);
    expect(parseImport("x".repeat(600_000), "sql")).toBeNull();
  });
});
