# LibCal Gantt Day Carousel

Submodule of `libcal_gantt`. It adds one block, **LibCal Day Carousel
(Bootstrap)**: a full-height Bootstrap 5 carousel with one slide per
library day. Each slide shows the date, the NWS forecast, building hours
for each campus row, and that day's events.

## Why it is a submodule

* No file in `libcal_gantt` changes, so Origami's Gantt and homepage
  blocks behave exactly as before.
* Credentials, calendars, campus rows, hours feeds, weather coordinates and
  caches all come from `/admin/config/services/libcal-gantt`. Nothing is
  configured twice.
* `CarouselEventsController` extends `GanttEventsController` and serves
  `/libcal-gantt/carousel-events`. It returns the parent payload with
  weather for the whole forecast window (about 7 days, weekends included)
  instead of the parent's 3. The parent's `WEATHER_DAYS` is read through
  `self::`, so a subclass can't override it. The subclass calls the parent
  method and then fills in the remaining days with the same
  `libcal_gantt.weather` service.

## Requirements

* `libcal_gantt` enabled, with **Show weather** on and latitude, longitude
  and contact set.
* Bootstrap 5 JS on the page (Palefire provides it). Without it the block
  falls back to a horizontal scroll-snap strip.

## Install

```
drush en libcal_gantt_carousel -y && drush cr
```

Place the block, or render it inside the `events_carousel` paragraph
(see `palefire_modular`).

## Three days at xl and xxl

From Bootstrap's `xl` breakpoint up (1200px, read from
`--bs-breakpoint-xl`), the carousel shows three days side by side, one
per column. Below that it shows one day per slide as before.

* **Moving:** Previous/Next, swipe and Left/Right move the view by one
  day. The first day in view is Bootstrap's active slide.
* **The end:** the last view always has three days, ending on the last
  day, so Next is disabled one view early.
* **Day tabs:** all three days in view are highlighted. Choosing one of
  the last two days shows the last view.
* **Hidden columns:** days outside the view are `inert`, so they can't
  be tabbed to and screen readers skip them. If focus was on a link in a
  day that leaves the view, it moves to that view's first day tab.
* **Announcements:** "Showing Tuesday, October 13, 2026 to Thursday,
  October 15, 2026 (days 2–4 of 10)".
* **Fewer days:** with only two days, there are two columns. With one,
  it stays a single slide.
* **Changing it:** `WIDE_COLUMNS` and `WIDE_QUERY` at the top of
  `js/day-carousel.js`. Speed and easing are `--ldc-speed` and
  `--ldc-ease`; column padding is `--ldc-col-pad`.
* **Without Bootstrap JS:** the scroll-snap fallback also shows three
  days per screen from 1200px up.
* **Column borders:** the first column in view (`.is-first-in-view`) fades
  out its left border as the view moves, so only the two borders either
  side of the middle day show. Same `--ldc-speed` as the slide.

## Previous/Next chevrons

The chevrons are inline SVGs drawn in `currentColor`
(`.libcal-day-carousel__chevron`), not Bootstrap's
`.carousel-control-*-icon`. Bootstrap's icon is a white background image
that `data-bs-theme="dark"` inverts to black, which made them invisible on
dark sections. They now follow the text colour in light and dark.

## Next events in "On this page" (Palefire)

On Palefire Modular pages the next three timed events (not all-day, not
already over, in day order) are listed under the calendar's entry in the
table of contents, like a section's h3 sub-links. Each event `<li>` gets an
id, `data-toc`, `data-toc-label` (its title), `data-toc-detail` (day and
time, for screen readers) and `data-toc-passive` (the columns are side by
side, so they aren't highlighted by scroll position). The block fires
`palefire:tocrefresh` once its days are built. Following one of the links
moves the carousel to that day, scrolls to the event and focuses its link.

* **Changing the number:** `TOC_EVENTS` in `js/day-carousel.js`, or
  `data-toc-events` on the block wrapper (`0` turns it off).
* **Requires** the Palefire theme commit that adds `[data-toc]` items and
  `palefire:tocrefresh` to `js/modular-toc.js`. Without it the attributes
  do nothing.

## Keyboard and screen readers

* **Inside the carousel:** with focus on a day tab or the Previous/Next
  buttons, Left/Right change the day (Bootstrap's `keyboard: true`).
* **Anywhere in the active section (Palefire modular pages):** when the
  carousel's section is the active one in the table of contents and is on
  screen, Left/Right change the day without tabbing in first, the keyboard
  equivalent of a swipe. It reads `body[data-active-section]`, which
  `palefire/js/modular-toc.js` sets, so it is off on pages without the TOC
  (Form mode, Origami, the block placed on its own).
* Left untouched: Up/Down (page scroll and scroll-snap), any modifier key
  (Alt+Left is browser Back), typing in form fields, widgets that use arrow
  keys themselves (tabs, menus, sliders, listboxes), open dialogs and the
  mobile "On this page" panel.
* **Announcements:** a polite live region reads the new day, e.g. "Tuesday,
  October 13, 2026 (2 of 10)", after a change made by the user. Autoplay
  changes are not announced.
* **Autoplay:** stops for good after the first change made by keyboard,
  click or swipe. Bootstrap's hover pause alone would restart it when the
  pointer leaves.
