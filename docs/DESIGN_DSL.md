# Design DSL

## DesignDoc
```json
{ "id": "doc", "tokens": "default", "root": {
  "id": "n_root", "type": "Frame", "props": {"width": 390, "height": 844, "direction": "column", "gap": "md", "padding": "lg"},
  "children": [] } }
```
Every node: `{ id, type, props, children? }`. Ids are stable `n_<short>` strings assigned by
the gateway, never by the model (the model uses `"$new:<alias>"` and the gateway rewrites).

## The 12 primitives (the only renderable types)
| Primitive | Key props | Children |
|---|---|---|
| Frame | width, height, direction, gap, padding, align, fill | yes |
| Stack | direction, gap, align, justify | yes |
| Text | content, variant (display/title/body/caption), color | no |
| Button | label, variant (primary/secondary/ghost), size | no |
| Input | label, placeholder, kind (text/email/password) | no |
| Image | alt, aspect, src? (placeholder if absent) | no |
| Icon | name (lucide), size, color | no |
| Card | padding, elevation | yes |
| List | items[] of {title, subtitle} | no |
| Nav | items[], position (top/bottom) | no |
| Table | columns[], rows[][] | no |
| Chart | kind (bar/line), series | no |

Props reference **tokens**, not raw values: color `primary|secondary|surface|muted|danger|text`,
spacing `xs|sm|md|lg|xl`, radius `none|sm|md|full`. Raw hex only inside TOKEN_SETS.

## Patch contract
Model output is newline-delimited JSON, one RFC 6902 op per line:
```
{"op":"add","path":"/root/children/-","value":{"id":"$new:logo","type":"Image","props":{"alt":"Logo","aspect":"1:1"}}}
{"op":"replace","path":"/root/children/2/props/variant","value":"primary"}
```
The gateway validates each line with zod the moment it closes; invalid ops are dropped and
logged, never shown. Paths may use `#<node id>` shorthand, resolved by the gateway.
