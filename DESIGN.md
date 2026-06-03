# Work Radar — Design System

> work-radar의 **시각 디자인 정본(source of truth)**. 기존 Raycast 다크 방향에서
> **Cohere 스타일(white editorial enterprise AI)**로 피봇됨 (2026-05-21).
> 이전 Raycast 방향은 `docs/archive/design-raycast.md`에 보존.
>
> **적용 범위 메모 (work-radar 컨텍스트):**
>
> - **앱 전반 적용:** 토큰 계열(Colors / Typography / Layout / Elevation / Shapes)과
>   `button-primary` · `button-secondary` · `button-pill-outline` · `capability-card` ·
>   `product-card` · `contact-form-card` · `agent-console-card`.
> - **웹/마케팅/랜딩 표면 전용:** `announcement-bar` · `trust-logo-strip` ·
>   `hero-photo-card` · `blog-filter-chip` · `research-table` · `footer-newsletter`.
>   데스크톱 앱 셸(매트릭스 · cmdk 팔레트 · PR Radar · Jobs 등)에는 적용하지 않는다.
> - 시각 토큰은 Tailwind v4 `@theme`로 등록하고, 컴포넌트는 shadcn/ui 프리미티브 위에 구현.

---

## Overview

Cohere's current web presence feels like a sober enterprise AI command center with editorial restraint. The home page opens on a huge typographic declaration over a white canvas, then uses photography, dark product mockups, trust logos, and generous empty space to make AI infrastructure feel controlled rather than speculative. Product pages invert the tone into deep green-black or dark navy bands, while blog and research pages move toward publishing-system clarity: large filters, thin rules, dense lists, and pale technical backgrounds.

What makes the system distinctive is the mix of austere black-and-white UI with bursts of tactile brand imagery. The site avoids decorative chrome in the normal interface; color arrives through photography, abstract 3D media, coral blog taxonomy chips, blue research links, and dark product environments. Cards are rounded but not cute. Type is large, tight, and almost monospaced in spirit, creating a research-lab cadence across marketing, product, and editorial surfaces.

**Key Characteristics:**

- Monumental display headlines with very tight line height and negative tracking.
- White editorial canvases interrupted by deep green, dark navy, and image-led CTA bands.
- Rounded media cards and product cards, usually 8px to 22px.
- Pill CTAs in near-black or white, with most secondary actions rendered as underlined text links.
- Trust-logo strips with monochrome partner marks and very wide vertical spacing.
- Agent-console mockups using dark panels, small status chips, and product integration badges.
- Blog and research surfaces with prominent taxonomy chips, long rule-separated lists, and search fields.

## Colors

### Brand & Accent

- **Cohere Black** (`#000000`): Announcement bar, highest-contrast text, and the global brand anchor.
- **Near-Black Primary** (`#17171c`): Primary CTA buttons, dark footer, and deep UI cards.
- **Deep Enterprise Green** (`#003c33`): Product hero bands for North and Command-style dark sections.
- **Dark Navy** (`#071829`): Financial-services and security-oriented solution bands.
- **Action Blue** (`#1863dc`): Editorial links, pagination, and secondary action emphasis.
- **Coral** (`#ff7759`): Blog category chips, taxonomy outlines, and warm product markers.
- **Soft Coral** (`#ffad9b`): Pale chip borders and segmented article-label details.

### Surface & Background

- **Canvas White** (`#ffffff`): Dominant page background and form/card surface.
- **Soft Stone** (`#eeece7`): Product cards, testimonial placeholders, and warm neutral surface blocks.
- **Pale Green Wash** (`#edfce9`): North page section backdrop behind stacked dark capability panels.
- **Pale Blue Wash** (`#f1f5ff`): Blog CTA surface behind abstract 3D imagery.
- **Card Border** (`#f2f2f2`): Softest card containment line.

### Text & Rules

- **Ink** (`#212121`): Default body text and most link text on light backgrounds.
- **Muted Slate** (`#93939f`): Footer links, dates, metadata, and de-emphasized labels.
- **Slate** (`#75758a`): Research separators and tertiary text.
- **Hairline** (`#d9d9dd`): Standard list rules and section dividers.
- **Border Light** (`#e5e7eb`): Secondary divider and utility rule.

### Semantic

- **Focus Blue** (`#4c6ee6`): Keyboard focus and ring color (`--color-wr-focus` / `--ring`).
- **Form Focus Violet** (`#9b60aa`): Focus border for text inputs.
- **Error Red** (`#b30000`): Danger/error text (`--color-wr-danger`). Aligned with `--color-today-debt-urgent` and `--color-wr-diff-del-fg` so all error-severity signals share one token.

### Agent Status Colors

- **Status Working** (`#16a34a`, `--color-wr-status-working`): Agent active/running indicator (green).
- **Status Waiting** (`#eab308`, `--color-wr-status-waiting`): Agent awaiting input (yellow).

> **a11y rule:** Never use these colors alone to convey meaning. Always pair with a text/icon label (e.g., "working" · "waiting"). Color-only status is forbidden per the global design rule.

### Today & Timeline Colors

Semantic tokens for the Today view and timeline surface (`--color-today-*`). Previously inlined as hex literals in `todayBlocks.ts`; now tokenized for light/dark consistency.

| Token                              | Value     | Use                                        |
| ---------------------------------- | --------- | ------------------------------------------ |
| `--color-today-signal`             | `#4c6ee6` | Today signal accent (= Focus Blue)         |
| `--color-today-routine`            | `#5a8a78` | Sage — routine block marker                |
| `--color-today-debt-urgent`        | `#b30000` | Error Red — overdue urgent (= wr-danger)   |
| `--color-today-debt-urgent-border` | `#e0b4a8` | Overdue urgent border (= wr-danger-border) |
| `--color-today-debt-warn`          | `#a89175` | Warm stone — overdue warning               |
| `--color-today-debt-warn-border`   | `#d8c8b5` | Overdue warning border                     |
| `--color-today-now-line`           | `#ff7759` | Coral — current-time indicator line        |
| `--color-event-fallback`           | `#93939f` | Muted Slate — event with no project color  |

### Diff / Worktree Colors

Tokens for the skills/worktree diff view. Light values in `@theme`; dark overrides in `.dark`.

| Token                     | Light value | Dark value | Use                   |
| ------------------------- | ----------- | ---------- | --------------------- |
| `--color-wr-diff-add-bg`  | `#e6f4ec`   | `#16312a`  | Added-line background |
| `--color-wr-diff-add-fg`  | `#1d7a4d`   | `#5fb89e`  | Added-line text       |
| `--color-wr-diff-del-fg`  | `#b30000`   | `#ff6b6b`  | Deleted-line text     |
| `--color-wr-diff-hunk-fg` | `#1863dc`   | `#6b9bf0`  | Hunk-header text      |

### Component Token Overrides

Fine-grained tokens that keep component-specific values out of magic numbers in JSX/CSS:

| Token                      | Value     | Rationale                                                                                      |
| -------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `--color-wr-sticky-border` | `#c9c7c0` | Left accent border on sticky/postit notes — warm gray that reads on white canvas               |
| `--wr-graph-node-size`     | `10px`    | Commit-graph node diameter (bespoke — graph owns lane hues)                                    |
| `--wr-graph-line-width`    | `2px`     | Commit-graph lane line width                                                                   |
| `--wr-diff-line-pad-x`     | `10px`    | Horizontal padding inside diff line rows                                                       |
| `--color-wr-on-dark-btn`   | `#ffffff` | Text on near-black buttons (inverts to dark in `.dark` because button background also inverts) |
| `--color-wr-on-coral-btn`  | `#ffffff` | Text on coral/green buttons (does not invert — button background does not invert in dark mode) |

### Gradient System

Cohere does not use gradients as a generic UI fill. Gradients and color fields are media-led: abstract 3D hero imagery, deep blue open-science particle fields, red-orange product video posters, and dark green-to-black product environments. Keep UI surfaces flat; reserve gradient richness for large media panels and CTA image bands.

## Typography

### Font Family

- **Display**: `CohereText`, falling back to `Space Grotesk`, `Inter`, `ui-sans-serif`, and `system-ui`.
- **Body/UI**: `Unica77 Cohere Web`, falling back to `Inter`, `Arial`, `ui-sans-serif`, and `system-ui`.
- **Technical labels**: `CohereMono`, falling back to `Arial`, `ui-sans-serif`, and `system-ui`.
- **Icons**: Cohere uses custom icon fonts and thin-line geometric illustrations.

### Hierarchy (Marketing / Web Surfaces Only)

> **Scope:** This scale applies to **marketing and web/landing surfaces only** (announcement bars, hero sections, blog, research pages, product bands). It is **not implemented** as `typo-*` utilities and does **not apply** to the desktop app shell. For the app shell (capture board, agent bar, settings, etc.), use the **App Surface Type** table below — that is the canonical scale with `@utility` implementations.

| Role            | Font       | Size | Weight | Line Height | Letter Spacing | Notes                                   |
| --------------- | ---------- | ---: | -----: | ----------: | -------------: | --------------------------------------- |
| Hero Display    | CohereText | 96px |    400 |        1.00 |        -1.92px | Home page declaration scale.            |
| Product Display | CohereText | 72px |    400 |        1.00 |        -1.44px | Product and research hero headlines.    |
| Section Display | Unica77    | 60px |    400 |        1.00 |         -1.2px | Large product-page headings.            |
| Section Heading | Unica77    | 48px |    400 |        1.20 |        -0.48px | Split hero and CTA headings.            |
| Card Heading    | Unica77    | 32px |    400 |        1.20 |        -0.32px | Feature card and list section titles.   |
| Feature Heading | Unica77    | 24px |    400 |        1.30 |              0 | Cards, filters, and article titles.     |
| Body Large      | Unica77    | 18px |    400 |        1.40 |              0 | Lead text and larger paragraphs.        |
| Body            | Unica77    | 16px |    400 |        1.50 |              0 | Default copy and link text.             |
| Button          | Unica77    | 14px |    500 |        1.71 |              0 | Compact CTA labels.                     |
| Caption         | Unica77    | 14px |    400 |        1.40 |              0 | Metadata and small explanatory text.    |
| Mono Label      | CohereMono | 14px |    400 |        1.40 |         0.28px | Uppercase technical labels.             |
| Micro           | Unica77    | 12px |    400 |        1.40 |              0 | Footer, nav microcopy, and small links. |

### Principles

- Use massive type sparingly; Cohere pages often have one oversized headline and then settle into restrained 16px-24px UI copy.
- Keep display type tight. Hero copy should feel compact and carved, not airy.
- Avoid heavy bold weights. Size, spacing, and surface contrast do most of the hierarchy work.
- Use uppercase mono labels for category and system markers, especially on product and research pages.
- Editorial pages can use coral chips and blue links, but the base typography remains black and measured.

### App Surface Type (work-radar shell)

The dense desktop shell runs **tighter and heavier** than the marketing scale above — this is intentional editorial density for an information-dense command surface, and it overrides the "avoid heavy bold" principle _for app-shell UI only_ (marketing/display type still follows the Hierarchy table above). These roles are codified as `typo-*` utilities in `src/styles/typography.css`, whose values reference `--text-*`/`--leading-*`/`--tracking-*` tokens in `src/styles/tokens.css`.

| Utility            |  px | weight | line | tracking | Use                                                                                   |
| ------------------ | --: | -----: | ---: | -------: | ------------------------------------------------------------------------------------- |
| `typo-title-md`    |  17 |    600 | 1.25 |  -0.01em | Card/section titles (project cards).                                                  |
| `typo-title-sm`    |  15 |    600 |  1.3 |  -0.01em | Secondary titles.                                                                     |
| `typo-body-md`     |  13 |    400 |  1.4 |        0 | Default dense body.                                                                   |
| `typo-body-strong` |  13 |    600 |  1.4 |        0 | Emphasized body / inline headers.                                                     |
| `typo-label-sm`    |  12 |    500 |  1.4 |        0 | Form labels, compact UI.                                                              |
| `typo-caption-sm`  |  11 |    400 |  1.4 |        0 | Metadata, captions.                                                                   |
| `typo-mono-label`  |  11 |    600 |  1.4 |   0.12em | Uppercase mono section markers (`font-mono`). Size = `var(--text-caption-sm)` = 11px. |
| `typo-micro`       |  10 |    400 |  1.4 |        0 | Microcopy, footers.                                                                   |

Rule: author with the `typo-*` utility, never re-combine raw `text-/font-/leading-/tracking-` for these roles. `typo-*` sets type only; pair with a color utility (`text-foreground`, `text-muted-foreground`, …). See `docs/areas/typography.md`.

## Layout

### Spacing System

The system uses an **8px density base**. Compact operational UI (app shell rows, agent boxes, capture-board cells) uses the `--wr-density-*` token scale. Larger structural spacing (section padding, hero breathing room) uses Tailwind's standard scale inline where unavoidable.

#### Density Token Scale (`--wr-density-*`)

These tokens govern tight operational rhythm in the app shell — row gaps, inner padding, icon gutters:

| Token              | Value | Typical use                              |
| ------------------ | ----: | ---------------------------------------- |
| `--wr-density-2xs` |   2px | Micro gaps (icon-to-label, dot margins)  |
| `--wr-density-xs`  |   4px | Compact icon padding, tight row insets   |
| `--wr-density-sm`  |   6px | Row vertical padding, chip inner spacing |
| `--wr-density-md`  |   8px | Default gap unit (baseline)              |
| `--wr-density-lg`  |  12px | Section inner gaps, card padding base    |
| `--wr-density-xl`  |  16px | Card padding, panel inner margins        |

One-off structural values (marketing/landing surfaces) remain inline where unavoidable: `20px`, `22px`, `24px`, `28px`, `32px`, `36px`, `40px`, `56px`, `60px`, `64px`, `80px`. These are not tokenized — prefer the density scale or Tailwind defaults for new app-shell work.

Large sections rely on dramatic vertical breathing room. The home page places a trust-logo strip far below the hero media. Product pages often hold dark panels inside fields of empty white space, then transition to dense forms or footers only near the end.

### Grid & Container

- Global nav uses a three-zone layout: logo left, menu centered, sign-in/CTA right.
- Home hero is centered text above a two-card media composition: a wide product mockup card beside a narrower photography card.
- Feature sections commonly use 3-column cards on desktop.
- Product pages alternate centered hero blocks, trust-logo strips, large single-feature bands, and 2- or 3-column card grids.
- Research pages use full-width lists with date and chip columns instead of decorative cards.
- Forms use two-column input rows inside a rounded white card on dark or stone section backgrounds.

### Whitespace Philosophy

Cohere uses whitespace as a trust signal. Large empty intervals separate the brand claim, customer proof, product proof, and CTA. Dense content appears only where it serves the information architecture: research paper rows, blog card grids, and contact form fields.

## Elevation & Depth

Cohere is mostly flat. Depth comes from surface alternation, media contrast, rounded corners, and thin borders rather than drop shadows.

| Level              | Treatment                                             | Use                                                   |
| ------------------ | ----------------------------------------------------- | ----------------------------------------------------- |
| Flat               | No shadow, white or dark field                        | Hero copy, research lists, editorial surfaces         |
| Bordered           | 1px `#d9d9dd`, `#e5e7eb`, or dark translucent rules   | Research rows, forms, pale cards, footer inputs       |
| Media Lift         | Rounded image or video over contrasting section color | Hero photo cards, product videos, CTA imagery         |
| Dark Product Field | Deep green or navy full-width band                    | Command, North, financial services, security sections |

### Shadow Token Scale (`--wr-shadow-*`)

Six shadow tokens implement the elevation levels above. Raw values are defined in `src/styles/tokens.css`; always reference the token, never write the raw shadow inline.

| Token                  | Value                              | Use                                             |
| ---------------------- | ---------------------------------- | ----------------------------------------------- |
| `--wr-shadow-hairline` | `0 1px 0 rgb(10 14 30 / 0.02)`     | Subtlest separation — sticky headers, row rules |
| `--wr-shadow-sm`       | `0 8px 22px rgb(10 14 30 / 0.08)`  | Card lift — postit-card, capture-panel          |
| `--wr-shadow-md`       | `0 14px 32px rgb(10 14 30 / 0.12)` | Floating panels, drawers                        |
| `--wr-shadow-lg`       | `0 24px 60px rgb(10 14 30 / 0.18)` | Modals, full overlay sheets                     |
| `--wr-shadow-overlay`  | `0 24px 60px rgb(10 14 30 / 0.28)` | Command palette, highest-elevation overlays     |
| `--wr-shadow-toast`    | `0 2px 8px rgb(10 14 30 / 0.12)`   | Toast notifications (intentionally compact)     |

> **Rule:** "무거운 그림자 금지" (no heavy shadows) means staying at `--wr-shadow-sm` or below for persistent app-shell surfaces. `--wr-shadow-md` and above are reserved for transient overlays.

### Z-Index Scale (`--wr-z-*`)

Layer hierarchy for shared CSS. Use these before reaching for ad-hoc `z-*` values:

| Token            | Value | Layer                                              |
| ---------------- | ----: | -------------------------------------------------- |
| `--wr-z-base`    |     0 | Default document flow                              |
| `--wr-z-raised`  |     2 | Inline raised elements (sticky note actions, etc.) |
| `--wr-z-popover` |    40 | Popovers, dropdowns, tooltips                      |
| `--wr-z-command` |    90 | Cmd+K command palette                              |
| `--wr-z-drawer`  |    96 | Calendar drawer, side sheets                       |
| `--wr-z-toast`   |   200 | Toast notifications (always on top)                |

## Shapes

### Radius Scale

| Token  |  Value | Role                                                              |
| ------ | -----: | ----------------------------------------------------------------- |
| `xs`   |    4px | Small images, search fields, article thumbnails, utility elements |
| `sm`   |    8px | Blog chips, cards, small media, dialogs                           |
| `md`   |   16px | Medium product cards and grouped blocks                           |
| `lg`   |   22px | Signature media-card and soft placeholder radius                  |
| `xl`   |   30px | Research/topic filter pills                                       |
| `pill` |   32px | Primary CTA buttons                                               |
| `full` | 9999px | Round status elements and fully pill-shaped controls              |

### Image Treatment

Images are not decorative backdrops for text except in CTA bands. Most imagery sits as rounded cards with visible corners: product videos, enterprise photography, article thumbnails, and abstract 3D renders. The dominant radii are 8px and 22px.

## Motion

> **Principle:** "과한 모션 금지" — no excessive motion. Work Radar is a persistent utility surface; transitions must feel immediate and controlled, not decorative. All `transition` / `animation` durations and easings must reference the tokens below.
>
> **Exceptions:** MatrixCanvas card drag (physics-tuned values) and the `cb-pop` spring animation are intentionally bespoke and do not use these tokens.

### Duration Tokens (`--wr-motion-*`)

| Token                | Value   | Use                                          |
| -------------------- | ------- | -------------------------------------------- |
| `--wr-motion-fast`   | `0.12s` | Hover states, toggles, quick feedback        |
| `--wr-motion-base`   | `0.18s` | View transitions, standard element changes   |
| `--wr-motion-slow`   | `0.28s` | Slide-in popovers, slower reveal transitions |
| `--wr-motion-panel`  | `0.22s` | Modal, palette, and toast appearance         |
| `--wr-motion-drawer` | `0.32s` | Drawer / sheet appearance                    |
| `--wr-motion-space`  | `0.42s` | Screen / workspace-level transitions         |

### Easing Tokens (`--wr-ease-*`)

| Token              | Value                            | Use                                                      |
| ------------------ | -------------------------------- | -------------------------------------------------------- |
| `--wr-ease-out`    | `cubic-bezier(0.16, 1, 0.3, 1)`  | Standard material deceleration (default)                 |
| `--wr-ease-in`     | `cubic-bezier(0.7, 0, 0.84, 0)`  | Fast exit / dismissal                                    |
| `--wr-ease-spring` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Standard spring curve (capture-panel pop)                |
| `--wr-ease-space`  | `cubic-bezier(0.22, 1, 0.36, 1)` | macOS Spaces-like deceleration for workspace transitions |

## Components

### **`button-primary`**

Near-black or white pill CTA, depending on surface contrast. Uses 14px-16px Unica77, 12px 24px padding, and a 32px pill radius. This is the primary action style for "Request a demo", "Submit", and hero CTAs.

### **`button-secondary`**

Text-only action link, usually underlined or rule-aligned, with no filled background. Used for "Explore products", "Try the Playground", newsletter signup, and secondary hero actions.

### **`button-pill-outline`**

Outlined pill control with transparent fill, 1px dark border, and 30px radius. Used for research filters, topic tags, and lightweight taxonomy controls.

### **`announcement-bar`**

Full-width black strip above the nav, 36px tall, centered microcopy with an underlined "Learn more" link and a close control at the far right.

### **`hero-photo-card`**

Rounded media card used in the home hero and solution pages. It combines photography or abstract imagery with an overlaid dark agent-console module. Radius is usually 22px on large cards and 8px on smaller thumbnails.

### **`agent-console-card`**

Dark product mockup panel showing agent names, status chips, integration badges, prompt fields, and generated response cards. Background is near-black, text is white or muted, and small accent chips use product colors.

### **`trust-logo-strip`**

Centered copy above a row of monochrome customer logos. It is intentionally quiet: no cards, no borders, just large horizontal spacing and black or white logos depending on the background.

### **`capability-card`**

Content block with thin-line geometric illustration, 24px heading, body copy, and a text link. On light backgrounds, cards often have only a top rule or a subtle image/card relationship rather than full boxing.

### **`dark-feature-band`**

Deep green or navy full-width section used for product capabilities, security claims, and feature breakdowns. Text turns white; cards use darker translucent surfaces, pale borders, and abstract line illustrations.

### **`product-card`**

Warm stone card used for product/model summaries. Typically 3-column on desktop, with 8px radius, generous padding, a small pill button, a divider line, and checkmark bullet rows.

### **`blog-filter-chip`**

Large coral taxonomy chip used on the blog index. Active chips invert to coral fill with dark text; inactive chips use coral outline and pale fill. Typography is oversized relative to typical filters, making the taxonomy a hero-level control.

### **`research-table`**

Rule-separated publication list with title left, topic pills centered, and date right. Rows are tall, white, and border-driven; filters above use many compact outlined pills.

### **`contact-form-card`**

Rounded white form panel set against dark green or warm stone sections. Inputs are rectangular with thin gray borders, 12px-16px padding, and compact labels/placeholders. Submit uses the same near-black pill style as primary CTAs.

### **`footer-newsletter`**

Dark footer subscription block with coral "AI moves fast" label, white headline, muted legal microcopy, a single-line email field, and arrow submit marker. Footer columns use white section labels and muted links.

## Do's and Don'ts

### Do

- Use white canvas as the default surface; introduce dark green or navy as full-width product bands.
- Keep primary CTAs pill-shaped and near-black on light surfaces.
- Use 22px radius on major media cards and placeholders.
- Use coral for editorial taxonomy and small warm accents, not as the main CTA system.
- Use monochrome trust logos with wide spacing.
- Use thin-line geometric illustrations for research and capability icons.
- Let photography and product mockups carry color, while the UI shell stays restrained.

### Don't

- Do not turn coral or blue into broad decorative surface colors.
- Do not add heavy drop shadows to cards.
- Do not make every section card-based; Cohere often uses unframed rows, rules, and open space.
- Do not use rounded cards below 8px for major media.
- Do not replace the display/body type split with one generic sans-serif voice.
- Do not render undocumented interaction variants in documentation or previews.
- Do not use saturated gradients as normal UI backgrounds; keep gradients media-led.

## App Surface — Capture Board (work-radar 전용)

> 데스크톱 앱의 핵심 인터랙션. Cohere 토큰을 그대로 쓰되, 마케팅 컴포넌트가 아닌
> **상주 유틸 표면**이다. 인터랙션 레퍼런스 구현: `docs/prototypes/capture-board.html`.

### 캡처 보드 반지름 토큰 (`--cb-r-*`)

캡처 보드와 InboxColumn 등 같은 시각 시스템을 공유하는 컴포넌트에 적용되는 전역 토큰. `src/styles/tokens.css`에 정의됨.

| Token       | Value | Use                                               |
| ----------- | ----: | ------------------------------------------------- |
| `--cb-r-sm` |   8px | 카드/well 소형 반지름 (postit-card 등)            |
| `--cb-r-md` |  12px | 중형 패널 반지름 (InboxColumn, 섹션 카드)         |
| `--cb-r-lg` |  16px | 대형 패널 반지름 (capture-panel, today-rail 외곽) |

### 컨셉

캡처 보드는 **앱 창 전체를 채우는 불투명 보드**다(현행 단일 창 유지; Tauri 투명 데스크톱
오버레이는 폐기 — 클릭스루/멀티모니터 리스크). 흰 캔버스 위에 아이젠하워 2×2 가이드(얇은
hairline 룰)와 포스트잇, 그리고 따로 떠 있는 **조작 패널**이 얹힌다.
"흩어진 신호를 모아 손으로 정리한다"는 제품 철학을 공간적으로 표현한다.

### 컴포넌트

- **`postit-card`** — 흰색 카드(`#fff`), 1px `border-light` 보더, 좌측 4px 사분면 악센트 바,
  radius `sm`(8–10px). 흰 캔버스 위 카드 분리를 위해 **절제된 Media Lift 그림자**만 허용
  (`--wr-shadow-sm` = `0 8px 22px rgb(10 14 30 / 0.08)`; Cohere "무거운 그림자 금지"의 한정 예외).
  본문은 `typo-body-md`(13px), **하단에 생성일**(`typo-mono-label` 또는 `typo-micro`). 우상단 `⋯` 액션 버튼(hover/선택 시 노출).
- **`quadrant-guide`** — 2×2 셀. 얇은 hairline 룰(`--hair`/`border-light`, 흰 캔버스 기준),
  코너 라운드 `lg`(22px). 라벨 = Mono(EN, 예 `Q1 · DO NOW`) + Body(KO, `긴급 · 중요`) +
  사분면 도트. **색만으로 의미 전달 금지 — 항상 라벨 병기.**
  - 사분면 악센트: **Q1 = Coral `#ff7759`, Q2 = Deep Green `#003c33`, Q3 = Action Blue `#1863dc`, Q4 = Muted Slate `#93939f`.**
  - 드롭 호버 시 셀에 사분면 색의 옅은 wash.
- **`capture-panel`** — 따로 떠 있는 흰색 floating 박스, radius `lg`(22px), 약한 그림자.
  구성: Mono 라벨 `BRAIN DUMP`(coral) · **`kind-toggle`** · 입력 · `button-primary`("붙이기") · 통계/Work Debt 행.
- **`kind-toggle`(개인/업무 세그먼트)** — pill 세그먼트. **기본 선택 = 업무.**
  활성 개인 = Pale Blue 배경 + Action Blue 텍스트, 활성 업무 = Pale Green 배경 + Deep Green 텍스트.
- **`tag-chip`(개인/업무)** — 카드 상단 작은 pill. 개인 = Pale Blue/Action Blue, 업무 = Pale Green/Deep Green.
  **라벨 병기**(개인/업무 텍스트). 입력 맨 앞 토큰 마커가 토글값보다 우선.
- **`card-action-menu`** — `⋯`/`Cmd+K`/우클릭으로 카드에서 파생. 흰색 드롭다운(radius `sm`–`md`).
  상단 Mono em-라벨 `승격` 아래: 백로그 등록 · 안건 승격 · 캘린더 등록(= `Promotion` draft, Acceptance 대기) ·
  **Today 추가**(로컬 승격, Acceptance 불요), 구분선, 미루기/완료/보관(`S/D/E`).
  **외부 승격(notion/calendar)은 외부를 직접 바꾸지 않는다(Acceptance 대기); Today는 로컬 즉시.**
- **`today-rail`(Today's Todo)** — 보드 **우측 고정 세로 레일(기본 표시)**; 세로 모니터에선 하단 시트/접기.
  오늘 집중 항목 큐레이션. 매트릭스 카드를 레일로 드래그하거나 액션 "Today 추가"로 채움 — 승격된 카드는
  **매트릭스에서 제거**(Today 전용). 각 항목 = **완료 체크박스** + 원 사분면 **Q1~Q4 배지**(분류돼 있었으면) +
  area/kind 칩, 재정렬. 날짜 헤더(오늘). **미완료 항목은 다음날 유지(rollover)**.
  각 항목에 **경과일 배지 `+N`**(Mono) — 옮긴 날 +1, 이월될수록 증가. 오래될수록 강조(muted → coral),
  숫자 병기로 색만 의존하지 않음. hover 시 **↩ 매트릭스로 되돌리기** 버튼(승격 취소) — 원 사분면 복귀.
  흰 캔버스 카드 + 얇은 hairline 보더, Mono 라벨 `TODAY`.
- **`routines-panel`(Routines)** — 보드 **우측 하단 영역**. 오늘 해당하는 반복 작업 체크리스트.
  각 행 = **완료 체크박스** + 제목 + **스케줄 칩**(`매일` / `수·금` / `금` 등 Mono) + area/kind 칩. `+ 루틴`으로 추가
  (제목 + 스케줄 피커: 매일 / 요일 토글). 완료는 **날짜별**(다음날 리셋). 흰 캔버스 카드 + hairline 보더, Mono 라벨 `ROUTINES`.
- **`toast`** — near-black pill, 하단 중앙. "··· — Acceptance 대기" 등 비차단 피드백.

### 모션

- **촤라락(fan-out):** 보드 진입 시 미분류 카드가 한 점에서 staggered spring으로 펼쳐짐(카드당 ~85ms 지연).
- **톡(pop):** 새 캡처 카드가 scale pop(.3→1.07→1, ~340ms)으로 등장.
- **drag snap / re-pack:** 드롭 후 left/top 트랜지션(~500ms, ease-out)으로 사분면 내 자동정렬.
- 일반 트랜지션 150–220ms. 과한 모션 금지(상주 유틸).

### 배치 규칙 (5영역 레이아웃)

흐름: **캡처(하단) → 미분류(좌) → 결정 2×2(중앙) → 실행(우)**. 가로(landscape) 기준 배치:

```
┌─ Work Radar / Capture ────────────────────────────────────────────┐
│ 미분류 INBOX │   Q1 긴급·중요   │   Q2 중요       │  TODAY           │
│ ▢ ▢          │   ▢ ▢            │   ▢             │  ▢ Q1  +1        │
│ ▢ ▢          │ ─────────────────┼─────────────────│  ▢ Q2  +3        │
│ ▢            │   Q3 긴급        │   Q4 버림       │──────────────────│
│              │   ▢              │                 │  ROUTINES        │
│              │                  │                 │  ☑ 운동   매일   │
│              │                  │                 │  ☐ 주간회고  금  │
├──────────────┴──────────────────┴─────────────────┴──────────────────┤
│   [ BRAIN DUMP ]  〔개인│업무〕  입력…                  [ 붙이기 ]    │
└────────────────────────────────────────────────────────────────────┘
```

- **좌 = INBOX(미분류):** 캡처가 떨어지는 곳. 카스케이드(좁으면 1열)/그리드.
- **중앙 = 아이젠하워 2×2:** 결정 큐. 드래그 분류, 카드는 항상 unclassified 진입(INVARIANT #1).
- **우 = 실행:** 상단 `today-rail`(Q1~Q4 배지 + `+N`), 하단 `routines-panel`(스케줄 체크리스트).
- **하단 = 캡처:** 고정 brain-dump 패널(개인/업무 토글, 기본 업무).
- **비중: 2×2(중앙)가 주 영역.** INBOX(~178px)·실행 컬럼(~250px)은 슬림 고정, 매트릭스가
  가로 폭의 ~60%+ 차지(min 440px). 결정 큐가 시각적 중심이 되도록. 권장 최소 창폭 ~1040px; 그 이하는 반응형 축소.

### 반응형(보드)

- **가로(≥1040px):** 좌 미분류 / 중앙 2×2 / 우(Today 위·Routines 아래) 3컬럼 + 하단 캡처바.
- **중간(~720–1040px):** 우측 컬럼을 **Today·Routines 세그먼트 탭**으로 합쳐 1패널.
- **세로·좁음(<720px):** 세로 스택 — 미분류 트레이 → 2×2 → Today → Routines(접기 가능) → 하단 캡처바.
  2×2 축 라벨 간소화, 매우 좁으면 KO 라벨 숨김.
- 조작 패널 폭 `min(640px, 100%-여백)`, 좁으면 행 wrap.

## App Surface — Agent Bar · Header Timer · Calendar Drawer · Enrich Panel (work-radar 전용)

> UI 이슈 오케스트레이션(2026-05-23, plan-design-review)에서 추가된 상주 앱 표면.
> Cohere 토큰을 그대로 쓰되 마케팅 컴포넌트가 아닌 **상주 유틸 표면**이다.
> 마케팅용 `agent-console-card`(다크 목업)와 혼동 금지 — 아래는 **밝은 상주 스트립**.

### **`agent-status-bar`** (상주 최상단 스트립)

- 흰 캔버스(`#fff`), 하단 1px `hairline`. 높이 ~56–64px(현행 얇은 트랙에서 상향).
- 내용 = `agent-box` 가로 행 + 좌측 Mono 마이크로 라벨 `AGENTS`.
- **`agent-box`**: 1px `border-light`, radius `sm`(8px). 구성:
  - thin-line **engine 아이콘**(codex=terminal · hermes=paper-plane · claude=sparkle).
  - **편집 가능 이름**(Body 14px). 더블클릭/편집아이콘 → 인라인 input, Focus Blue(`#4c6ee6`) 링.
  - **상태 = 색 dot + Mono 마이크로 라벨 병기**(idle=Muted Slate `--color-wr-subtle` · working=`--color-wr-status-working` `#16a34a` · error=Error Red `--color-wr-danger`).
    **색만으로 의미 금지**(DESIGN 전역 규칙 — 항상 텍스트/아이콘 라벨 병기).
  - **진행 백필**: working 시 박스를 좌→우로 채우는 옅은 wash(과한 그림자/그라데이션 금지).
  - **너비 = 경과 시간 기반**: idle=초기(~96px), 길어질수록 증가, **상한 ~240px**(bounded).
- **hermes·cmux 세션 각 1박스**(세션 enumerate). **개수 상한 8 + '+N' 오버플로 칩**
  (`button-pill-outline` 스타일, 클릭 시 나머지 팝오버).
- **빈 상태(에이전트 없음)**: 조용한 단일 `Agents · idle` pill(Mono 라벨), 박스 없음.

### **`sprint-timer`** (브랜드 헤더 내 카운트다운)

- 위치 = 뷰 헤더("Work Radar / Capture" 등) **우측 존**. (에이전트 바와 분리.)
- 카운트다운 `D일 HH:MM` = **CohereMono**, Ink 색. 1분 단위 갱신.
- 상태: not-configured=`스프린트 설정` 텍스트 링크(`button-secondary`) · running=mono 카운트다운 ·
  **overdue=카운트다운 Coral + Mono `지남` 라벨**(색+라벨 병기).
- 클릭 → **팝오버 에디터**(흰 카드 radius `lg`): interval_days 스테퍼 + 기준요일·시각 피커 +
  `button-primary` 저장. (모델 = 길이+앵커 조합.)

### **`calendar-drawer`** (우측 슬라이드 드로어)

- 캡처 보드 **우측에서 슬라이드 인**(today-rail 위 오버레이/확장). 흰 패널, 좌측 모서리 radius `lg`,
  좌측 1px `hairline`. 무거운 그림자 금지(절제된 Media Lift만).
- 헤더: Mono `CALENDAR` + **일/주/월 세그먼트**(`kind-toggle` 스타일 pill) + `‹ 오늘 ›` 날짜 네비.
- 본문: 일=시간 행 / 주=7열 / 월=셀 그리드. 이벤트=radius `sm` 블록, 종일/시간 분리.
- 상태: loading=스켈레톤 행 · empty=따뜻한 "이 날짜에 일정 없음" + 맥락 ·
  **OAuth 미연결=`Google Calendar 연결` `button-primary`** · error=재시도.
- 닫기: ESC / 백드롭 / 우상단 ✕.

### **`enrich-review-panel`** (보드 내 인라인 제안 검토)

- "전체 제안 실행" 완료 시 **오버레이가 아닌 보드 영역 인라인 패널**(INBOX 컬럼 자리/보드 패널).
  카드는 계속 보이게 — 결정 맥락 유지(INVARIANT #1).
- 헤더 Mono `제안 검토 (N)`. 행 = 카드 제목 + **수정 가능** 제안(사분면/우선순위 칩) + 적용/건너뜀.
- 푸터: `모두 적용`(`button-primary`) + `닫기`. **사람이 수정 후 적용해야 반영**(자동 적용 금지).
- 상태: running=진행 표시(에이전트 바 연동) · partial=행 스트리밍 · empty="제안 없음" · error=재시도.

### Cmd+K 팰레트 — 스킬 그룹핑

- 스킬은 Cmd+K에서 Mono 섹션 라벨 `SKILLS` 아래 노출. **현재 프로젝트 관련 스킬 우선**(표시 그룹핑).
- 선택은 **제안까지만**(잡 자동 실행/확정 금지, INVARIANT #1).

### 반응형(신규 표면)

- **agent-status-bar**: 좁으면 박스 너비 축소 + '+N' 더 빨리. 매우 좁으면 이름 숨기고 아이콘+상태만.
- **sprint-timer**: 좁으면 `D일 HH:MM`→`D일`만, overdue 색 유지.
- **calendar-drawer**: ≥1040px=우측 드로어 / <720px=하단 시트로 전환(보드 반응형과 일관). 월뷰는 좁으면 주뷰로 강등.
- **enrich-review-panel**: 좁으면 전체폭 스택.

### a11y(신규 표면)

- 모든 상태는 **색+라벨/텍스트 병기**(이미 전역 규칙). 포커스=Focus Blue 링.
- agent-box 이름 편집·드로어·팰레트 **키보드 도달 가능**(Tab/Enter/ESC). 터치 타깃 ≥44px.
- 카운트다운은 `aria-live=polite`로 분 단위 갱신만 알림(과알림 금지).

## Responsive Behavior

### Breakpoints

| Name          |       Width | Key Changes                                                      |
| ------------- | ----------: | ---------------------------------------------------------------- |
| Small Mobile  |      <425px | Single-column cards, compact nav, reduced hero headline scale    |
| Mobile        |   425-640px | Hero media stacks, card grids become one column, form rows stack |
| Large Mobile  |   640-768px | Wider one-column layouts with larger media cards                 |
| Tablet        |  768-1024px | Two-column cards begin, nav spacing tightens                     |
| Desktop       | 1024-1440px | Full nav, 3-column card grids, split hero compositions           |
| Large Desktop | 1440-2560px | Wide containers and large empty vertical intervals               |

### Touch Targets

Primary CTAs and pills meet comfortable touch sizing through 12px-24px padding and pill radii. Research filter chips and blog category chips are larger than standard tags, making dense taxonomy surfaces usable on touch devices.

### Collapsing Strategy

- Nav collapses from full horizontal links to a compact mobile menu.
- Hero media moves from split cards to stacked cards.
- Product and capability grids collapse from 3 columns to 2 and then 1.
- Form fields collapse from paired rows to a single column.
- Research rows preserve their rule-separated structure but stack metadata below titles on smaller widths.

## Iteration Guide

1. Start from a white canvas or a full-width dark green/navy band; avoid mid-tone page backgrounds unless the screenshot shows a specific CTA/form section.
2. Use `button-primary` for the single highest-priority action and `button-secondary` for the companion action.
3. Use `hero-photo-card` or `agent-console-card` when a page needs visual energy; avoid invented dashboard data.
4. For editorial pages, combine `blog-filter-chip`, `button-pill-outline`, and `research-table` instead of generic marketing cards.
5. Keep component examples structurally honest: placeholder product frames are better than invented product content.

## Known Gaps

- Exact proprietary font files are not bundled; use the documented fallbacks when implementing externally.
- Mobile screenshots were not regenerated in this public update, so mobile behavior is documented from the desktop system and existing responsive patterns.
- Some live pages lazy-load content blocks late; blank testimonial placeholders are documented as placeholder skeleton surfaces rather than filled testimonial cards.
- **Deferred (Finding #16):** `src/styles/typography.css` currently has no inline comments mapping each `@utility` to its token sources. Adding those comments is a doc improvement inside a `src/` file and is out of scope for this doc-only pass. Follow-up: add `/* --text-caption-sm = 11px */`-style annotations to `typography.css` in a future src-only commit.
