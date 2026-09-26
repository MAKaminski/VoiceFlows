import type { DesignDoc } from "./doc.js";

/** M1 playground doc: every one of the 12 primitives, default tokens. */
export const kitchenSinkDoc: DesignDoc = {
  id: "playground",
  tokens: "default",
  root: {
    id: "n_root", type: "Frame",
    props: { width: 390, height: 1400, direction: "column", gap: "md", padding: "lg", fill: "surface" },
    children: [
      { id: "n_nav", type: "Nav", props: { items: ["Home", "Designs", "Settings"], position: "top" } },
      { id: "n_logo", type: "Image", props: { alt: "Logo", aspect: "3:1", radius: "md" } },
      { id: "n_title", type: "Text", props: { content: "Welcome back", variant: "display" } },
      { id: "n_sub", type: "Text", props: { content: "Sign in to continue", variant: "body", color: "text" } },
      {
        id: "n_form", type: "Card", props: { padding: "lg", elevation: 1 },
        children: [
          {
            id: "n_fields", type: "Stack", props: { direction: "column", gap: "sm" },
            children: [
              { id: "n_email", type: "Input", props: { label: "Email", placeholder: "you@example.com", kind: "email" } },
              { id: "n_pw", type: "Input", props: { label: "Password", placeholder: "••••••••", kind: "password" } },
              { id: "n_signin", type: "Button", props: { label: "Sign in", variant: "primary", size: "lg" } },
              {
                id: "n_row", type: "Stack", props: { direction: "row", gap: "sm", justify: "between", align: "center" },
                children: [
                  { id: "n_ghost", type: "Button", props: { label: "Forgot password?", variant: "ghost", size: "sm" } },
                  { id: "n_icon", type: "Icon", props: { name: "shield-check", size: "md", color: "primary" } },
                ],
              },
            ],
          },
        ],
      },
      { id: "n_list", type: "List", props: { items: [{ title: "Q3 dashboard", subtitle: "Edited 2h ago" }, { title: "Onboarding flow", subtitle: "Edited yesterday" }] } },
      { id: "n_table", type: "Table", props: { columns: ["Screen", "Nodes", "Version"], rows: [["Login", "9", "4"], ["Home", "23", "11"]] } },
      { id: "n_chart", type: "Chart", props: { kind: "bar", series: [4, 7, 3, 9, 6] } },
    ],
  },
};
