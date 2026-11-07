# BluInn design notes

BluInn (everything under `app/(bluinn)`) is laid out like a modern
workspace app:

- a royal-blue **top bar** with the five nav sections as tabs
- a **context rail** on the left listing only the current section's pages
- a pale grey canvas, with a **hero banner** opening every page in the
  section's own tint: flat, one tone shift inside the hue, no blooms,
  rings or decorative icon
- white cards with a hairline and a soft lift, KPI cards with a coloured
  **accent bar**, and borderless tinted status pills

Use this file when you build or move a page, or when you add search,
filters or pagination to a list. In most cases the work is using the
primitives in `components/ui.tsx` rather than writing markup by hand.

## How the theme works

The tokens live in the `.admin-theme` block of `app/globals.css`. Pages use
Tailwind's standard colour names, and that block redefines the variables
behind them. So a class such as `text-brand-700` or `bg-emerald-100` inside
a page gets the BluInn palette without renaming anything. Do not add a
`tailwind.config`, and do not hard-code hex values in pages. The one
exception is chart colours (see Charts).

| Tailwind name | Role | Key steps |
|---|---|---|
| `brand` | Royal blue: primary buttons, links, focus, top bar. Registered in `@theme`, so `bg-brand-600` etc. exist | 50 `#EFF5FF` · 100 `#DDE9FE` · 600 `#2659D8` primary · 700 `#1F47B4` links |
| `yellow` | A legacy alias of `brand`. Don't use it | same steps as `brand` |
| `slate` (also `stone`, `gray`) | Cool neutrals | 50 `#F5F7FA` canvas · 100 `#EEF1F5` · 200 `#E3E8EE` hairline · 500 `#637083` muted text · 900 `#121722` ink |
| `emerald` (also `green`) | Success, "all clear", live dots | 100 `#EAF7EC` success pill · 500 `#53AC58` |
| `lime` | Confirmed or arriving | 100 `#F5FCD0` pill · 900 text |
| `amber` | Pending or warning, and the revenue line | 100 `#FEF5DA` pill · 600 `#C98F1B` line |
| `rose` (also `red`) | Error or cancelled | 100 tint · 500 `#D36C5F` · 800 text |
| `blue` / `orange` / `violet` | Info / no-show / waitlist | 100 tint · 800 text |

### The legacy `yellow` alias

In the original gold theme the accent really was yellow, so for a while the
pages wrote the accent as `text-yellow-700` and `.admin-theme` mapped
`yellow` onto `brand`. Every page now writes `brand-*`. The alias stays in
`globals.css` only so a stray `yellow-*` still renders blue. Write `brand`,
which also works outside `.admin-theme`, where the alias does not apply.

### Section tints

Each top-level nav section has its own colour, applied by `GroupScope`
(`components/GroupScope.tsx`), which sets `data-group` on the shell from the
current path:

| Section (`data-group`) | Tint |
|---|---|
| Front Office (`front`) | blue |
| Operations (`ops`) | teal |
| Commercial (`commercial`) | violet |
| People (`people`) | amber |
| Admin (`admin`) | slate-indigo |

The tint is a set of CSS variables (`--g-50/100/200/500/600/700/800` and
`--hero-from/via/to`; the hero uses `via` → `from`, the sign-in panel all three) that the hero, the rail, `StatCard`, `CardHeader`,
`FilterChips`, `Pagination` and `SectionTabs` read with Tailwind's
`bg-(--g-100)` syntax. A server page never has to say which section it is
in. Use `--g-*` for decorative section colour; keep actions on `brand`
and status on the status palette.

### Colour rules

- **Primary action:** `buttonClass`, brand blue with white text. Use it for
  one per view.
- **Secondary action:** `secondaryButtonClass`, white with a hairline.
- **Links:** `text-brand-700 hover:text-brand-900`.
- **Row hover:** `hover:bg-slate-50` (`tableRowClass`).
- **Keyboard focus:** a blue outline, set globally. Inputs show their own
  soft blue ring.

## Type

Inter carries everything. `fonts.ts` loads it and the root layout puts it on
`<html>`; the theme points `--font-admin-display` at the same font.

| Element | Style |
|---|---|
| `h1` (page title) | 26px, semibold, −0.025em tracking; 28px and white inside the hero |
| `h2` (card title) | 16px, semibold, no letter spacing (only the `h1` is tightened) |
| `h3` | 15px, semibold |
| `.admin-display` (KPI figures, the wordmark) | semibold, −0.03em tracking |
| `.admin-eyebrow` (small labels: floor names, filter labels, drawer groups) | 12px, medium, sentence case, `slate-500` |
| Body text | regular weight, `text-sm` |
| Muted text | `text-slate-500` |

On screen, labels are sentence case: no `uppercase` with wide tracking, and
nothing under 11px. Printed documents (invoice, folio, credit note, BEO,
quotation, contract, KOT) keep their small uppercase field labels, which is
a document convention.

Short strings (titles, labels, buttons, empty states, alert rows) end
without a period; a message of two or more sentences keeps its periods.
Pluralise counts properly ("1 booking has", "3 bookings have"), never
"booking(s)": use `plural(n, "booking")` from `ui.tsx` (pass the
irregular form as a third argument: `plural(n, "child", "children")`).
Booking statuses are sentence case too ("Checked in", "No-show").

Selects draw their own muted chevron (set globally on `.admin-theme select`),
so don't add an icon or extra right padding to one.

The global rules set heading sizes, so a page doesn't need size classes on
`h1`, `h2` or `h3`. Tables and `.admin-display` get tabular figures
automatically.

## Motion

Keep motion small, and use CSS only (no animation library).

- **Route change:** `template.tsx` wraps each page in `.page-enter`, which
  fades it up by 6px over 240ms.
- **Hover and focus:** `transition-colors duration-150` on rows, chips,
  buttons and nav items. Clickable cards use `transition duration-200
  ease-out` with a slightly stronger border and shadow on hover, and their
  chevron nudges right. Never scale or bounce.
- **Rail:** one highlight element glides to the active item over 300ms
  (`NavList` in `Sidebar.tsx`).
- **Reduced motion:** the global `prefers-reduced-motion` rule turns all of
  it off, so you don't need to handle this per component.

## Shell

- **Navigation model** (`components/nav.ts`)
  - `NAV_GROUPS`: the five sections, each with a label, subtitle, icon and
    its items. Every item keeps its `any:` permission list.
  - `allowedGroups(access)` filters items by permission and drops empty
    sections. `groupFor(pathname)` picks the section holding the longest
    matching href.
- **Top bar** (`TopBar.tsx`, every breakpoint)
  - The wordmark (no descriptor line; it is too small to read there), then the section tabs: pills in a recessed track, the
    active one white with brand-blue text, each with its section icon from
    1536px. A tab opens the first page of that section the person may see.
  - The search box: the Bookings search (or Guests for staff without
    booking access), a plain GET form focused with ⌘K / Ctrl+K. Hidden
    between 1024 and 1280px, where the tabs need the room.
  - The property's local time in a glass chip like the search field (the
    active tab is the only white element in the bar), the bell (notification log, for roles that
    can open it), the signed-in person (links to Password & 2FA) and Sign
    out. Name and the Sign out label show from 1536px.
  - Below 1024px the tabs give way to a menu button that opens the drawer.
- **Status strip** (`StatusStrip.tsx`): a translucent white bar with an
  "Open" pill (pulsing green dot), today's date at the hotel and the property.
- **Canvas**: the content column carries `admin-canvas`, a faint wash of the
  section's `--g-100` at the top over the slate-50 canvas. It prints plain.
- **Rail** (`Sidebar.tsx`)
  - A header card in the section's tint (icon tile, name, subtitle), the
    property switcher, then the section's pages, and "My account" at the
    foot.
  - The mobile drawer lists every allowed section with its pages.
  - Pages outside the nav (Password & 2FA) show a "My account" rail.

## Signed-out screens

Sign-in (`login/page.tsx`), two-step verification (`login/verify/page.tsx`),
the setup notice (`components/SetupNotice.tsx`, shown until a database is
configured), and the fallback screens (`app/not-found.tsx`, `app/error.tsx`,
`app/global-error.tsx`) share `components/AuthShell.tsx`: the brand panel on the left from 1024px
(the glass stripes over the hero gradient, the headline, and four module
highlights; copy only, never figures. No badge pill above the headline,
and the accent words "one desk." are solid ice blue `#a9c6ff`, never gradient
text) and the form in a white card on the
right. Below 1024px the panel collapses to a short gradient header the card
overlaps. Pass `badge` for an icon tile above the title.

- **Glass stripes** (`components/GlassStripes.tsx`) fill the brand panel:
  diagonal fluted-glass stripes refracting a slow blue glow that leans
  towards the pointer, drawn by one raw WebGL fragment shader (no three.js).
  It fades in once drawn; without WebGL the panel's CSS gradient, grid and
  rings show instead. It stops in hidden tabs and draws one still frame for
  reduced motion. Props: `stripeCount` (6–40), `angle` (degrees from
  vertical) and `colors` (`background`, `shadow`, `midtone`, `highlight`).
  The left side is shaded deeper on purpose, because the copy sits there.

- **Inputs** carry a leading icon that turns brand blue on focus; the
  password has a show/hide toggle.
- **The one big action** is a plain `buttonClass` (no gradient, no glow) and
  shows a spinner while pending.
- **The code field** (`login/verify/CodeInput.tsx`) is one real input named
  `code` laid transparently over six drawn slots, so autofill, paste and
  screen readers work on a plain field. It keeps digits only and submits the
  form when the sixth arrives.

## Components (`components/ui.tsx`)

| Primitive | Use |
|---|---|
| `PageHeader` | The hero banner that opens every page or section layout. Optional `eyebrow`, `chips` (glass pills, `tone: "warn"` for amber), `action`, `stats` (up to four glass tiles), `progress` (a bar along the foot). No decorative icon: the section's icon already sits in the rail. Title the page by its context (the page name, or the date on the dashboard), never a greeting. Prints as plain text |
| `Card` | Every boxed surface, including tables. Tables always sit inside a card |
| `CardHeader` | The header row of a list card: tinted icon tile, title, optional description, count badge, `action` and an "All ›" link |
| `SectionTitle` | An `h2` with an optional action, for cards with padded bodies |
| `StatCard` | A KPI card with a left accent bar in the section tint. `icon` adds a tinted tile beside the label; `href` adds a chevron; `highlight` makes it the tinted lead card (one per row) |
| `SectionTabs` | A section's sub-pages as a segmented bar under its hero. Hidden when there is only one tab |
| `StatusPill` | Booking status: tentative is amber, confirmed is lime, checked-in is green |
| `Tag` | Any other pill: tones `neutral`, `gold` (lime), `green`, `red`, `amber`, `blue`, `violet` |
| `Avatar` | Initials in a soft tint (the tint follows the name), beside the person a row is about |
| `Banner`, `Notice` | Inline messages |
| `EmptyState` | Centred muted line inside a card, with an optional `icon` |
| `Field`, `Check` | A form label with hint, and a checkbox row |
| `inputClass`, `buttonClass`, `secondaryButtonClass`, `dangerButtonClass` | Class strings for form controls and buttons |
| `tableHeadClass`, `tableRowClass` | The table header row (faint grey band, 12px sentence-case labels) and body rows |
| `SearchInput`, `FilterChips`, `Pagination` | List controls (see below) |

### Printed documents

Invoices, the folio, the registration card, the POS bill and KOT, the event
documents (`events/[id]/shared.tsx` `DocumentShell`: quotation, contract and
BEO) end with `components/PrintFooter.tsx`, a
single muted "Powered by BluInn" line. The hotel's name, address and GSTIN
stay in the document header, read from Settings. Add the footer to any new
document a guest or client receives. Guest emails never carry it.

Product identity (name, tagline, descriptor, company, theme colour) comes
from `PRODUCT` in `app/lib/app-config.ts`. Never type "BluInn" into a page.

### Wordmark and type details

- **The mark** (`BrandMark`) is a bold "B" monogram cut by one diagonal
  slit, which echoes the glass stripes, with a small cyan spark at the top
  right. It is solid white-to-ice, and the counters and slit are masked out,
  so it only works on blue surfaces. On the sign-in panel it sits on a dark
  glass tile (`admin-auth-brand-tile`), and the lockup carries a navy text
  shadow (`admin-auth-brand`) so it reads over the bright stripes.
- **The sign-in form side** stays white, with a faint, faded dot grid. The
  card is frosted glass (`admin-auth-form-card`): translucent white, a white
  edge and a strong backdrop blur.
- **The wordmark is two-tone** (`Wordmark` in `components/BrandMark.tsx`):
  "Blu" in the surface colour, "Inn" in pale blue (`.admin-wordmark-tail`; cyan
  on the sign-in panel). In Inter a capital I and a
  lower-case l are the same stroke, so a one-colour "BluInn" reads "Blulnn".
  The Google-hosted Inter has no serifed-I alternate (`cv08`), so the colour
  break does that job. Use the component; don't set the name by hand.
- **Tabular figures only in tables** (and `.tabular-nums`). Inter's tabular
  setting also widens the hyphen, so on display text "two-factor" read as
  "two - factor". Headline figures stay proportional.
- **Show dates with `fmtDate`**, never a bare `yyyy-mm-dd`. CSV exports keep
  ISO.
- **References never wrap**: inline `font-mono` text (BK-1001, invoice
  numbers) is `nowrap` globally.
- **Every `EmptyState` has an icon**: an inbox by default, or pass the
  section's own.

Every pill carries the `admin-pill` class, which drops its border. Add it to
any pill you write by hand.

### Actions on the hero

Whatever you pass as `PageHeader`'s `action` was probably written for a
white page. The hero restyles it in CSS, so pass the normal classes:

- `buttonClass` (marked `admin-btn`) turns white with section-coloured text.
- `secondaryButtonClass` (marked `admin-btn-secondary`) turns to glass.
- A plain text link or note given directly as the action turns white.

If you hand-roll a button that should follow these rules, add the marker
class to it.

## Adding search, filters and pagination to a list

Everything is driven by the URL and done in the server component. There is
no client state and no API route. `rooms/page.tsx` is the complete worked
example; `bookings/page.tsx` shows the same pieces on a simpler list.

### 1. Read the params

Read and sanitise the params, and fall back to defaults when they are
missing or invalid:

```ts
const params = await searchParams; // { q?, status?, page? }
const page = pageParam(params.page);
const status = STATUSES.includes(params.status) ? params.status : "all";
const term = (params.q ?? "").replace(/[%,()]/g, "").trim(); // commas and parentheses break .or()
```

### 2. Build the query

Apply the filters and the page range to the Supabase query itself:

```ts
let q = supabase.from("rooms").select("*", { count: "exact" })
  .order("room_number")
  .range(...pageRange(page));
if (status !== "all") q = q.eq("status", status);
if (term) q = q.or(`name.ilike.%${term}%,code.ilike.%${term}%`);
const { data, error, count } = await q;
```

- **Joined columns:** `.or()` cannot reach a column on a joined table.
  Resolve the matching ids with a separate query first, then add
  `col.in.(…)` to the `.or()`.
- **Headline figures:** if a count or total on the page was computed from
  the fetched rows, give it its own query before you add `.range()`.
  Otherwise it silently turns into a per-page figure.

### 3. Handle a stale page number

```ts
const listParams = { q: term, status: status === "all" ? null : status };
if (outOfRange(error)) redirect(pageHref("/rooms", listParams, 1));
```

### 4. Render the controls

```tsx
<FilterChips path="/rooms" param="status" current={status}
  params={{ q: term }} options={[{ value: "all", label: "All" }, …]} />
<SearchInput action="/rooms" defaultValue={term}
  keep={{ status: status === "all" ? null : status }} />
…table…
<Pagination page={page} total={count ?? 0} path="/rooms" params={listParams} />
```

- Put `Pagination` as the last child of the list's `Card`. It renders
  nothing when everything fits on one page.
- Each control carries the others' params (`params`, `keep`) and always
  drops `page`, so a new search or filter starts on page 1.
- The `"all"` option clears its param.
- Two paged lists on one page each need their own URL param. Pass
  `param="spage"` to the second `<Pagination>`, and the same name as the
  last argument of `pageHref`. Put the other list's page number in
  `params` so it is kept. `audit/security/page.tsx` is the example.
- Page size is `PAGE_SIZE` (20) from `components/paging.ts`. Don't pass a
  custom `pageSize`.

### 5. When a list is sorted or filtered in JS

Some lists can't page in the database, such as the maintenance open view
(sorted by urgency) and Events (filtered in JS). For those, load the full
list, slice it with `pageRange(clampPage(page, total))`, and pass
`total={list.length}`.

### When to add each control

- **Pagination:** when a list can plausibly grow past a screenful.
- **Search:** when rows have an obvious text field, such as a name, number or
  item.
- **Filter chips:** when there is a status, category or type column. Add
  counts when they come for free from data already loaded. A `swatch` lets
  the chips double as a colour legend.
- **None:** skip them on settings forms and on short fixed lists.

## Charts (`components/charts.tsx`, recharts)

- **Data:** charts are client components that take plain data props. The
  page fetches the data on the server.
- **Colours:** recharts writes colours as SVG attributes, which cannot read
  CSS variables. So the chart colours are hex constants, each named after the
  palette step it copies.
- **One axis per chart, never two.** "Occupancy & revenue" is tempting to
  draw with two y-scales. We draw it as two small multiples on a shared day
  axis, with a synced crosshair and tooltip. Occupancy is brand blue
  (`#2659D8`), revenue amber (`#C98F1B`).
- **Legends:** a chart with two or more series has a legend, and its panels
  carry labels. Every chart has a tooltip and a visually hidden (`sr-only`)
  data table.
- **Categorical palettes:** check them with the dataviz validator. Slice
  order matters: the room-status donut (occupied blue, vacant clean green,
  vacant dirty amber, out of order red, out of service grey) keeps the green
  away from the red. The grey fails the validator's chroma floor on purpose
  (an out-of-service room is out of play); the legend's labels and counts
  carry its identity. The room board tiles use the same hues.

## Migrating a page

1. Open it with `PageHeader`. Move a row of headline counters into its
   `stats`.
2. Wrap each table in a `<Card>`. Use `tableHeadClass` on the header row and
   `tableRowClass` on body rows; give list cards a `CardHeader`.
3. Replace hand-rolled pills with `Tag` or `StatusPill`, or add `admin-pill`.
4. Add an `Avatar` beside a person's name when that person is the row's
   subject.
5. Replace hand-rolled search forms and chip rows with `SearchInput` and
   `FilterChips`, then add pagination as described above.
6. Change appearance only. Keep the copy, data and behaviour exactly as they
   are.
