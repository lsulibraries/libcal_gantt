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
