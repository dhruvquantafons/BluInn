# BluInn design notes

BluInn (everything under `app/(bluinn)`) is laid out like a modern
workspace app:

- a royal-blue **top bar** with the five nav sections as tabs
- a **context rail** on the left listing only the current section's pages
- a pale grey canvas, with a **hero banner** opening every page in the
  section's own tint
- white cards with a hairline and a soft lift, KPI cards with a coloured
  **accent bar**, and borderless tinted status pills

Use this file when you build or move a page, or when you add search,
filters or pagination to a list. In most cases the work is using the
primitives in `components/ui.tsx` rather than writing markup by hand.

## How the theme works

The tokens live in the `.admin-theme` block of `app/globals.css`. Pages use
Tailwind's standard colour names, and that block redefines the variables
behind them. So a class such as `text-yellow-700` or `bg-emerald-100` inside
a page gets the BluInn palette without renaming anything. Do not add a
`tailwind.config`, and do not hard-code hex values in pages. The one
exception is chart colours (see Charts).

| Tailwind name | Role | Key steps |
|---|---|---|
| `brand` | Royal blue: primary buttons, links, focus, top bar. Registered in `@theme`, so `bg-brand-600` etc. exist | 50 `#EFF5FF` · 100 `#DDE9FE` · 600 `#2659D8` primary · 700 `#1F47B4` links |
| `yellow` | An alias of `brand` (the name is historic) | same steps as `brand` |
| `slate` (also `stone`, `gray`) | Cool neutrals | 50 `#F5F7FA` canvas · 100 `#EEF1F5` · 200 `#E3E8EE` hairline · 500 `#637083` muted text · 900 `#121722` ink |
| `emerald` (also `green`) | Success, "all clear", live dots | 100 `#EAF7EC` success pill · 500 `#53AC58` |
| `lime` | Confirmed or arriving | 100 `#F5FCD0` pill · 900 text |
| `amber` | Pending or warning, and the revenue line | 100 `#FEF5DA` pill · 600 `#C98F1B` line |
| `rose` (also `red`) | Error or cancelled | 100 tint · 500 `#D36C5F` · 800 text |
| `blue` / `orange` / `violet` | Info / no-show / waitlist | 100 tint · 800 text |

### Why the accent is called `yellow`

In the original gold theme the accent really was yellow, and about 180
links across the panel are still written as `text-yellow-700` or
`text-yellow-800`. Keeping the name lets all of them follow the accent
without editing each page. New code should prefer `brand`.

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
`--hero-from/via/to`) that the hero, the rail, `StatCard`, `CardHeader`,
`FilterChips`, `Pagination` and `SectionTabs` read with Tailwind's
`bg-(--g-100)` syntax. A server page never has to say which section it is
in. Use `--g-*` for decorative section colour; keep actions on `brand`
and status on the status palette.

### Colour rules

- **Primary action:** `buttonClass`, brand blue with white text. Use it for
  one per view.
- **Secondary action:** `secondaryButtonClass`, white with a hairline.
- **Links:** `text-brand-700 hover:text-brand-900` (older pages write
  `text-yellow-700`, which renders the same).
- **Row hover:** `hover:bg-slate-50` (`tableRowClass`).
- **Keyboard focus:** a blue outline, set globally. Inputs show their own
  soft blue ring.

## Type

Inter carries everything. `fonts.ts` loads it and the root layout puts it on
`<html>`; the theme points `--font-admin-display` at the same font.

| Element | Style |
|---|---|
| `h1` (page title) | 26px, semibold, −0.025em tracking; 28px and white inside the hero |
| `h2` (card title) | 16px, semibold |
| `h3` | 15px, semibold |
| `.admin-display` (KPI figures, the wordmark) | semibold, −0.03em tracking |
| `.admin-eyebrow` (small uppercase labels: floor names, filter labels, drawer groups) | 10.5px, 0.09em tracking, `slate-400` |
| Body text | regular weight, `text-sm` |
| Muted text | `text-slate-500` |

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
  - The wordmark, then the section tabs. A tab opens the first page of that
    section the person may see.
  - The search box: the Bookings search (or Guests for staff without
    booking access), a plain GET form focused with ⌘K / Ctrl+K. Hidden
    between 1024 and 1280px, where the tabs need the room.
  - The property's local time, the bell (notification log, for roles that
    can open it), the signed-in person (links to Password & 2FA) and Sign
    out. Name and the Sign out label show from 1536px.
  - Below 1024px the tabs give way to a menu button that opens the drawer.
- **Status strip** (`StatusStrip.tsx`): the business date and property on a
  green bar; amber with a "Night audit" button when the business date has
  fallen behind and the person can close it.
- **Rail** (`Sidebar.tsx`)
  - A header card in the section's tint (icon tile, name, subtitle), the
    property switcher, then the section's pages, and "My account" at the
    foot.
  - The mobile drawer lists every allowed section with its pages.
  - Pages outside the nav (Password & 2FA) show a "My account" rail.

## Components (`components/ui.tsx`)

| Primitive | Use |
|---|---|
| `PageHeader` | The hero banner that opens every page or section layout. Optional `eyebrow`, `chips` (glass pills, `tone: "warn"` for amber), `action`, `stats` (up to four glass tiles), `progress` (a bar along the foot) and `icon` (the decorative mark on the right; defaults to the BluInn mark). Prints as plain text |
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
| `tableHeadClass`, `tableRowClass` | The table header row (faint grey band, small uppercase labels) and body rows |
| `SearchInput`, `FilterChips`, `Pagination` | List controls (see below) |

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
   `stats`, and give it an `icon` when the page is a module of its own.
2. Wrap each table in a `<Card>`. Use `tableHeadClass` on the header row and
   `tableRowClass` on body rows; give list cards a `CardHeader`.
3. Replace hand-rolled pills with `Tag` or `StatusPill`, or add `admin-pill`.
4. Add an `Avatar` beside a person's name when that person is the row's
   subject.
5. Replace hand-rolled search forms and chip rows with `SearchInput` and
   `FilterChips`, then add pagination as described above.
6. Change appearance only. Keep the copy, data and behaviour exactly as they
   are.
