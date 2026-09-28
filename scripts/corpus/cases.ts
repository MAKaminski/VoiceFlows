/**
 * M7 fluency corpus (2026-09-28): how people actually talk to LiveCanvas, as speech-to-text writes it —
 * fillers, Flux mishearings ("rights to", "sign and"), passives, fan-in/fan-out, negation, colours on new
 * and existing elements, backgrounds, growing an ERD over several sentences, switching views mid-thought.
 *
 * One file, two runners:
 *  - offline (apps/gateway/test/corpus.test.ts): every word that needs the model reaches it (`hears`),
 *    instant cases make no model call, view switches land, one version per sentence;
 *  - live (scripts/e2e/corpus-live.mts): streams each case word by word to the deployed gateway and
 *    scores the finished design against `expect` (scripts/corpus/score.ts).
 *
 * Selectors — screen: "Type" or "Type:text" (text matched against label/content/alt/kind, lowercase);
 * "Title" = a title-variant Text; "root" = the screen itself. Diagrams: a label, matched loosely
 * (case, punctuation and plural ignored).
 */
export type View = "screen" | "architecture" | "erd" | "sequence";

export interface Expect {
  view?: View;                                  // the view the project ends on
  has?: string[];                               // elements that must exist
  hasNot?: string[];                            // elements that must not exist
  props?: Array<[string, string, string]>;      // [selector, prop, value] e.g. ["Button", "color", "pink"]
  first?: string; last?: string;                // screen order among root children
  edges?: Array<[string, string]>;              // directed: from → to
  links?: Array<[string, string]>;              // either direction
  noLinks?: string[];                           // no edge touches this element
  minEdges?: number;
  cols?: Array<[string, string[]]>;             // table → column names that must exist
}

export interface CorpusCase {
  id: string;
  view: View;                 // the view the case starts on
  setup?: string[];           // earlier sentences, one utterance each
  say: string;                // the sentence under test, as STT writes it
  expect: Expect;
  hears?: string[];           // offline: words that must reach the model (or Jev) — never silently dropped
  instant?: boolean;          // offline: drawn with no model call at all
  known?: string;             // a documented blind spot: reported, not counted against the bar
}

const LOGIN = "a login screen with email and password and a sign in button";

export const CASES: CorpusCase[] = [
  // ── Screen ─────────────────────────────────────────────────────────────────────────────────
  { id: "s-dod", view: "screen", say: "a login screen with email and password, big blue sign-in button, logo on top", instant: true,
    expect: { has: ["Input:email", "Input:password", "Button:sign in", "Image:logo"], first: "Image:logo", props: [["Button", "color", "primary"], ["Button", "size", "lg"]] } },
  { id: "s-dod-mishear", view: "screen", say: "a login screen with email and password big blue sign and button logo on top", instant: true,
    expect: { has: ["Button:sign in"], first: "Image:logo" } },
  { id: "s-pink-new", view: "screen", say: "a big pink sign up button", instant: true,
    expect: { has: ["Button:sign up"], props: [["Button", "color", "pink"]] } },
  { id: "s-orange-new", view: "screen", say: "an orange get started button", instant: true,
    expect: { props: [["Button:get started", "color", "orange"]] } },
  { id: "s-recolor-pink", view: "screen", setup: [LOGIN], say: "make the button pink", hears: ["pink"],
    expect: { props: [["Button", "color", "pink"]] } },
  { id: "s-recolor-orange-filler", view: "screen", setup: [LOGIN], say: "um can you make the sign in button like orange", hears: ["orange"],
    expect: { props: [["Button", "color", "orange"]] } },
  { id: "s-recolor-title", view: "screen", setup: ["a welcome screen with a title and a get started button"], say: "make the title green", hears: ["green"],
    expect: { props: [["Title", "color", "green"]] } },
  { id: "s-bg-pink", view: "screen", setup: ["a settings screen with a list"], say: "give it a pink background", hears: ["pink", "background"],
    expect: { props: [["root", "fill", "pink"]] } },
  { id: "s-bg-yellow", view: "screen", setup: [LOGIN], say: "change the background to yellow", hears: ["yellow"],
    expect: { props: [["root", "fill", "yellow"]] } },
  { id: "s-card-orange", view: "screen", setup: ["a checkout screen with a card"], say: "make the card orange", hears: ["orange"],
    expect: { props: [["Card", "fill", "orange"]] } },
  { id: "s-card-new-teal", view: "screen", say: "a teal card", instant: true, expect: { props: [["Card", "fill", "teal"]] } },
  { id: "s-icon-teal", view: "screen", say: "a big teal icon", instant: true, expect: { props: [["Icon", "color", "teal"], ["Icon", "size", "lg"]] } },
  { id: "s-two-colors", view: "screen", say: "a green save button and a red delete button", hears: ["delete"],
    expect: { props: [["Button:save", "color", "green"], ["Button:delete", "color", "danger"]] } },
  { id: "s-pink-then-logo", view: "screen", setup: [LOGIN], say: "make the button pink and add a logo", hears: ["pink"],
    expect: { has: ["Image:logo"], props: [["Button", "color", "pink"]] } },
  { id: "s-move-top", view: "screen", setup: ["a profile screen with an avatar a title and a list"], say: "put the list on top", instant: true,
    expect: { first: "List" } },
  { id: "s-move-bottom", view: "screen", setup: ["a login screen with a logo email and password and a sign in button"], say: "move the logo to the bottom", instant: true,
    expect: { last: "Image:logo" } },
  { id: "s-remove", view: "screen", setup: [LOGIN], say: "remove the password field", hears: ["remove"],
    expect: { hasNot: ["Input:password"], has: ["Input:email"] } },
  { id: "s-rename", view: "screen", setup: ["a sign up button"], say: "change the button text to create account", hears: ["create", "account"],
    expect: { has: ["Button:create account"] } },
  { id: "s-dashboard", view: "screen", say: "a dashboard with a chart a table and a menu", instant: true,
    expect: { has: ["Chart", "Table", "Nav", "Title"] } },
  { id: "s-fillers", view: "screen", say: "uh so like a sign up page with um username and password and a big purple sign up button", instant: true,
    expect: { has: ["Input:text", "Input:password", "Button:sign up"], props: [["Button", "color", "secondary"]] } },
  { id: "s-forgot-link", view: "screen", setup: ["a login screen with email and password"], say: "and also add a forgot password link under the password", hears: ["forgot", "link"],
    expect: { has: ["*:forgot"] } },
  { id: "s-smaller", view: "screen", setup: [LOGIN], say: "make the button smaller", hears: ["smaller"],
    expect: { props: [["Button", "size", "sm"]] } },
  { id: "s-open-bio", view: "screen", setup: ["a profile screen with an avatar"], say: "add a short bio and a follow button", hears: ["bio"],
    expect: { has: ["Button:follow", "*:bio"] } },
  { id: "s-checkout", view: "screen", say: "a checkout screen with the order total and a big green pay button", hears: ["total"],
    expect: { has: ["Button:pay", "*:total"], props: [["Button", "color", "green"]] } },

  // ── Architecture ───────────────────────────────────────────────────────────────────────────
  { id: "a-basic", view: "architecture", say: "a web app calls an api which writes to postgres",
    expect: { has: ["web app", "api", "postgres"], edges: [["web app", "api"], ["api", "postgres"]] } },
  { id: "a-rights-to", view: "architecture", say: "the web app calls the api and the api rights to postgres", hears: ["rights"],
    expect: { edges: [["web app", "api"], ["api", "postgres"]] } },
  { id: "a-right-to", view: "architecture", setup: ["a web app calls an api"], say: "the api right to redis for caching", hears: ["right"],
    expect: { links: [["api", "redis"]] } },
  { id: "a-fan-in", view: "architecture", setup: ["an api a worker and postgres"], say: "the api and the worker both write to postgres", hears: ["write"],
    expect: { edges: [["api", "postgres"], ["worker", "postgres"]] } },
  { id: "a-fan-out", view: "architecture", setup: ["an api redis and postgres"], say: "the api reads from redis and postgres", hears: ["reads"],
    expect: { links: [["api", "redis"], ["api", "postgres"]] } },
  { id: "a-queue", view: "architecture", say: "the api publishes jobs to a queue and a worker consumes them",
    expect: { links: [["api", "queue"], ["worker", "queue"]] } },
  { id: "a-queue-clause", view: "architecture", say: "the api writes jobs to a queue and a worker reads from postgres",
    expect: { links: [["api", "queue"], ["worker", "postgres"]], noLinks: [] } },
  { id: "a-mulesoft", view: "architecture", say: "mulesoft connects salesforce and genesys to a backend called shaw", hears: ["shaw"],
    expect: { has: ["mulesoft", "salesforce", "genesys", "shaw"], links: [["mulesoft", "salesforce"], ["mulesoft", "genesys"]], minEdges: 3 } },
  { id: "a-owner", view: "architecture", setup: ["a backend called shaw"], say: "shaw is owned by the full stack team", hears: ["owned"],
    expect: { has: ["shaw"], props: [["shaw", "owner", "full"]] } },
  { id: "a-observe", view: "architecture", setup: ["genesys and observe ai"], say: "observe ai reads call recordings from genesys",
    expect: { links: [["observe", "genesys"]] } },
  { id: "a-deploy", view: "architecture", setup: ["a web app calls an api"], say: "the api runs on railway and the web app is deployed on vercel",
    expect: { has: ["railway", "vercel"], links: [["api", "railway"], ["web app", "vercel"]] } },
  { id: "a-passive", view: "architecture", setup: ["a worker and postgres"], say: "postgres is read by the worker",
    expect: { links: [["worker", "postgres"]] } },
  { id: "a-negation", view: "architecture", setup: ["an api stripe and twilio"], say: "the api calls stripe but not twilio",
    expect: { edges: [["api", "stripe"]], noLinks: ["twilio"] } },
  { id: "a-fillers", view: "architecture", say: "um so the uh mobile app talks to the api gateway which like routes to the backend",
    expect: { has: ["mobile app", "api gateway", "backend"], links: [["mobile app", "api gateway"], ["api gateway", "backend"]] } },
  { id: "a-cache", view: "architecture", setup: ["an api redis and postgres"], say: "the api checks redis before hitting postgres", hears: ["checks"],
    expect: { links: [["api", "redis"], ["api", "postgres"]] } },
  { id: "a-grow", view: "architecture", setup: ["a web app calls an api"], say: "the api also writes to postgres and sends emails through sendgrid",
    expect: { links: [["api", "postgres"], ["api", "sendgrid"]] } },
  { id: "a-named-service", view: "architecture", setup: ["a web app calls an api"], say: "the api calls a pricing service called quoter", hears: ["quoter"],
    expect: { has: ["quoter"], links: [["api", "quoter"]] } },
  { id: "a-rename", view: "architecture", setup: ["a web app calls an api"], say: "rename the api to core service", hears: ["rename"],
    expect: { has: ["core"] } },
  { id: "a-remove", view: "architecture", setup: ["a web app calls an api which writes to postgres and redis"], say: "remove redis", hears: ["remove"],
    expect: { hasNot: ["redis"], has: ["postgres"] } },
  { id: "a-kafka", view: "architecture", say: "the orders service publishes events to kafka and an analytics worker subscribes to them", hears: ["orders", "analytics"],
    expect: { has: ["kafka"], minEdges: 2 } },
  { id: "a-switch", view: "screen", say: "now the architecture a react app calls a fastify api", expect: { view: "architecture", edges: [["react", "api"]] } },
  { id: "a-lb", view: "architecture", say: "a load balancer sits in front of the api servers",
    expect: { has: ["load balancer"], minEdges: 1 } },
  { id: "a-okta", view: "architecture", setup: ["a web app calls an api"], say: "users sign in through okta before the web app talks to the api",
    expect: { has: ["okta"], links: [["web app", "api"]], minEdges: 2 } },
  { id: "a-genesys-bot", view: "architecture", setup: ["genesys and salesforce"], say: "the genesys bot looks up the customer in salesforce", hears: ["looks"],
    expect: { has: ["genesys bot"], links: [["genesys bot", "salesforce"]] } },

  // ── ERD ────────────────────────────────────────────────────────────────────────────────────
  { id: "e-basic", view: "erd", say: "users and orders, each user has many orders",
    expect: { edges: [["users", "orders"]], cols: [["orders", ["user_id"]]] } },
  { id: "e-columns", view: "erd", setup: ["users and orders each user has many orders"], say: "users have an email and a name", hears: ["email", "name"],
    expect: { cols: [["users", ["email", "name"]]] } },
  { id: "e-cases", view: "erd", say: "customers and their support cases, each customer has many cases",
    expect: { has: ["customers", "cases"], edges: [["customers", "cases"]] } },
  { id: "e-contact-center", view: "erd", say: "agents handle many calls and each call has one recording",
    expect: { has: ["agents", "calls", "recordings"], links: [["agents", "calls"], ["calls", "recordings"]] } },
  { id: "e-add-table", view: "erd", setup: ["users and orders each user has many orders"], say: "add a products table and orders have many products", hears: ["add"],
    expect: { has: ["products"], links: [["orders", "products"]] } },
  { id: "e-priority", view: "erd", setup: ["customers and cases each customer has many cases"], say: "cases have a priority a status and a subject", hears: ["priority", "subject"],
    expect: { cols: [["cases", ["priority", "status", "subject"]]] } },
  { id: "e-crm-fanout", view: "erd", say: "accounts have many contacts and many opportunities",
    expect: { edges: [["accounts", "contacts"], ["accounts", "opportunities"]] } },
  { id: "e-belongs", view: "erd", setup: ["customers and orders"], say: "each order belongs to a customer", instant: true,
    expect: { edges: [["customers", "orders"]], cols: [["orders", ["customer_id"]]] } },
  { id: "e-owned-fan", view: "erd", setup: ["tickets comments and agents"], say: "each comment and each ticket is owned by an agent",
    expect: { edges: [["agents", "comments"], ["agents", "tickets"]] } },
  { id: "e-assigned", view: "erd", setup: ["cases and agents"], say: "every case is assigned to an agent", instant: true,
    expect: { edges: [["agents", "cases"]], cols: [["cases", ["agent_id"]]] } },
  { id: "e-not-belongs", view: "erd", setup: ["users and teams"], say: "users do not belong to teams",
    expect: { noLinks: ["teams"] } }, // the negation guard: never drawn as a relationship
  { id: "e-one-to-one", view: "erd", setup: ["users"], say: "each user has one profile", hears: ["profile"],
    expect: { has: ["profile"], links: [["users", "profile"]] } },
  { id: "e-many-many", view: "erd", say: "students enroll in many courses and courses have many students", hears: ["enroll"],
    expect: { has: ["students", "courses"], minEdges: 2 } },
  { id: "e-switch", view: "architecture", setup: ["a web app calls an api"], say: "and in the er diagram customers have many cases",
    expect: { view: "erd", edges: [["customers", "cases"]] } },
  { id: "e-switch-db", view: "screen", say: "switch to the database diagram with patients and appointments each patient has many appointments",
    expect: { view: "erd", edges: [["patients", "appointments"]] } },
  { id: "e-fillers", view: "erd", say: "um so like leads uh and each lead can have many activities", hears: ["activities"],
    expect: { has: ["leads", "activities"], links: [["leads", "activities"]] } },
  { id: "e-timestamps", view: "erd", setup: ["users"], say: "add created at and updated at timestamps to users", hears: ["created", "updated"],
    expect: { cols: [["users", ["created_at", "updated_at"]]] } },
  { id: "e-rename", view: "erd", setup: ["users and orders"], say: "rename users to customers", hears: ["rename"],
    expect: { has: ["customers"], hasNot: ["users"] } },
  { id: "e-health", view: "erd", say: "doctors have many patients and patients have many prescriptions",
    expect: { edges: [["doctors", "patients"], ["patients", "prescriptions"]] } },
  { id: "e-unknown-table", view: "erd", say: "a vehicles table with a make a model and a year", hears: ["make", "year"],
    expect: { has: ["vehicles"], cols: [["vehicles", ["make", "model", "year"]]] } },
  { id: "e-grow-3", view: "erd", setup: ["tickets", "each ticket has many comments"], say: "comments have an author and a body", hears: ["author", "body"],
    expect: { cols: [["comments", ["author", "body"]]], edges: [["tickets", "comments"]] } },
  // ── Implied suggestions (M8, ADR 0020): offered at once, applied only on "approve".
  { id: "g-approve-cases", view: "erd", setup: ["customers and cases each customer has many cases"], say: "approve",
    expect: { cols: [["cases", ["subject", "status", "priority"]], ["customers", ["email"]]] } },
  { id: "g-approve-but", view: "erd", setup: ["cases"], say: "approve all but priority",
    expect: { cols: [["cases", ["subject", "status"]]] } },
  { id: "g-reject", view: "erd", setup: ["cases"], say: "reject",
    expect: { has: ["cases"] } },
  { id: "g-screen-forgot", view: "screen", setup: ["a login screen with email and password"], say: "approve",
    expect: { has: ["*:forgot"] } },
  { id: "e-agents-skills", view: "erd", setup: ["agents and skills"], say: "agents have many skills and skills have many agents", hears: ["many"],
    expect: { minEdges: 2 } },

  // ── Sequence ───────────────────────────────────────────────────────────────────────────────
  { id: "q-login", view: "sequence", say: "the user logs in on the web app, the app posts credentials to the api, the api checks postgres and returns a token",
    expect: { has: ["user", "web app", "api", "postgres"], minEdges: 3, edges: [["api", "postgres"]] } },
  { id: "q-rights", view: "sequence", setup: ["the web app calls the api"], say: "the api rights to postgres then returns ok to the web app", hears: ["rights"],
    expect: { edges: [["api", "postgres"]], minEdges: 2 } },
  { id: "q-stripe", view: "sequence", say: "the web app asks the api to charge the card, the api calls stripe, stripe returns a charge id",
    expect: { edges: [["api", "stripe"], ["stripe", "api"]] } },
  { id: "q-fillers", view: "sequence", say: "um the client sends a request to the gateway uh the gateway forwards it to the api",
    expect: { edges: [["client", "gateway"], ["gateway", "api"]] } },
  { id: "q-async", view: "sequence", say: "the api enqueues a job on the queue and the worker sends an email",
    expect: { has: ["api", "queue", "worker"], minEdges: 2 } },
  { id: "q-switch", view: "screen", say: "a sequence diagram where the browser requests the page from the server",
    expect: { view: "sequence", has: ["browser", "server"], minEdges: 1 } },
  { id: "q-grow", view: "sequence", setup: ["the web app sends the login to the api and the api returns a token"], say: "then the web app stores the token in the cache", hears: ["stores"],
    expect: { has: ["cache"], links: [["web app", "cache"]] } },
  { id: "q-auth", view: "sequence", say: "the app redirects the user to auth and auth returns a code to the app",
    expect: { has: ["auth"], minEdges: 2 } },
];
