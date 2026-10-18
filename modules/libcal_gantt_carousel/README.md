# LibCal Gantt Day Carousel

Submodule of `libcal_gantt`. It adds one block, **LibCal Day Carousel
(Bootstrap)**: a full-height Bootstrap 5 carousel with one slide per
library day. Each slide shows the date, the NWS forecast, building hours
for each campus row, and that day's events.

## Why it is a submodule

* Origami's Gantt and homepage blocks behave exactly as before. The only
  changes in `libcal_gantt` itself are a protected `selectCalendar()` seam
  (same output), so the carousel can merge calendars, and an extra
  `campusId` on each event, which the carousel filters libraries by.
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

## Quiet days: Wikipedia "On this day" (2026-10-16)

A day with no timed events (nothing, or only all-day items) shows one
Wikipedia "On this day" anniversary as the last thing in its column, after
the events (or "No events scheduled."), like the parent module's homepage
strip does for empty days. It is a fun add-on, so it is a small, muted
aside, not a feature (follow-up: it first sat in the feature slot at the
top, with an accent rule).

* **Server:** `CarouselEventsController::quietDays()` finds the days in
  the window with no timed segment (a segment that runs the whole day is
  all-day, the same test as the JS), and the parent's `OnThisDayClient`
  returns their facts in `onThisDay`. Same setting ("Show Wikipedia On this
  day facts on empty days" at `/admin/config/services/libcal-gantt`, off
  by default), same per-date cache, same soft failure: no setting, no
  answer from Wikipedia, no fact.
* **Looser than the homepage:** the parent counts any event, all-day
  included, as busy. The carousel only counts timed events, so a day with
  just a donation bin still gets a fact.
* **Front end:** one fact per day at random per page load
  (`pickFact()`), drawn by `buildFact()` with the homepage's wording
  ("On this day in 1859") and a required "Wikipedia" source link (the
  CC BY-SA attribution; its accessible name names the article and the new
  tab). A day with no events at all says "No events scheduled." above it.
  Markup: `.libcal-day__fact`, `__fact-label`, `__fact-text`,
  `__fact-source`.

## Only some libraries (2026-10-18)

The block's **Libraries (campus IDs)** setting is the carousel's version of
the "LSU Libraries" filter on LibCal's public calendar
(`cm=262` = Hill Memorial Library). It takes campus IDs from the "Campus
rows" setting, comma-separated, e.g. "262" or "262,261". Empty means every
library.

- **The request:** the block prints `data-campus`, and `day-carousel.js`
  sends it as `?campus=` to `/libcal-gantt/carousel-events`.
- **Filtering:** `CarouselEventsController::filterByCampus()` keeps only
  those libraries' events, weekend items included.
- **Online events:** a library's online events stay in, as on LibCal.
  To make that possible, the parent payload now carries each event's
  `campusId`, which the Gantt grid and homepage don't use.
- **Hours:** the building hours on each slide are limited to the chosen
  libraries, in the order of the Campus rows setting.
- **Unknown IDs** are ignored.

The "Full calendar" link isn't changed. To land visitors on the same
filtered view, set the block's **Full calendar URL** to the LibCal link
with `cm=` in it. In palefire_modular the Events carousel paragraph's
`field_carousel_campuses` checkboxes set this.

## Several calendars in one carousel (2026-10-18)

The block's **Calendar key** takes one key or several, comma-separated
("8030,16219"). Keys are the first calendar ID on each line of the
"Calendars" setting on `/admin/config/services/libcal-gantt`. With two or
more keys, `CarouselEventsController::selectCalendar()` merges their LibCal
IDs into one request, as a "8030,16219|Combined" line would, and removes
duplicates. Unknown keys are ignored, and empty means the first calendar,
as before.

The parent controller now picks its tab in a protected
`GanttEventsController::selectCalendar()`. Its behaviour is unchanged, so
the Gantt grid and the homepage still read one `?calendar=` key. Only the
carousel's endpoint accepts a list.

In a Palefire Modular page, the Events carousel paragraph's
`field_carousel_calendars` checkboxes set this (see palefire_modular).

## Show only event days (2026-10-18)

The block setting **Show only event days** (`only_event_days`, off by
default) hides all-day events from the slides, then leaves out days with
no events left. All-day events used to stay listed on the days that were
kept; they no longer do.
The test for "all-day" is the one the slides use for their "All day" label:
a weekday segment that runs the whole day, or a weekend event from
12:00 AM to 11:59 PM. On the block it prints `data-only-event-days="1"`,
and `buildSlides()` in `day-carousel.js` filters the days before taking
the first **Slides (days)**, so that number counts event days.

- **Search window:** only the window already fetched, so there's no extra
  request. That window is libcal_gantt's weekday count (10 by default) plus
  the weekends in between, about two weeks. If fewer days in it have events,
  fewer slides show. If none do, the block says "No upcoming events in the
  next two weeks."
- **Weekends:** still follow "Include Saturday and Sunday slides".
- **"On this day" facts:** they only go on days without timed events, so
  with this setting on they never appear.

In a Palefire Modular page, the Events carousel paragraph's
`field_carousel_event_days` checkbox sets it (see palefire_modular).

## Featured image: timed events only (2026-10-16)

The feature slot only shows the image of a timed event. All-day items (a
donation bin, an open room) are standing notices, not the day's programme,
so their images are not featured.

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
