/**
 * @file
 * LibCal Day Carousel: one Bootstrap carousel slide per library day.
 *
 * Reads the same JSON as the parent LibCal Gantt module, from
 * /libcal-gantt/carousel-events, which is the parent payload plus weather
 * for the whole forecast window. This file is independent of
 * gantt-timeline.js. That file's helpers are private to its closure, so
 * the few needed here (weather icons, hour formatting) are copied. The
 * parent file is not modified.
 */
(function (Drupal, drupalSettings, once) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const WEATHER_POP_THRESHOLD = 30;

  // Copied from gantt-timeline.js so both blocks draw the same icons.
  const WEATHER_ICON_PATHS = {
    sun: ['M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z', 'M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5'],
    part: ['M9.4 7.6a3.4 3.4 0 0 1 4.6 4', 'M9.4 2.9v1.7M3.9 8.4h1.7M5.5 4.5l1.2 1.2', 'M8 19.4h8.1a3.3 3.3 0 0 0 .3-6.6A5.2 5.2 0 0 0 6.8 11.4 3.9 3.9 0 0 0 8 19.4z'],
    cloud: ['M8 18.6h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 10.6 3.9 3.9 0 0 0 8 18.6z'],
    rain: ['M8 15.2h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 7.2 3.9 3.9 0 0 0 8 15.2z', 'M8.6 18.1l-.8 2.4M12 18.1l-.8 2.4M15.4 18.1l-.8 2.4'],
    storm: ['M8 14.4h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 6.4 3.9 3.9 0 0 0 8 14.4z', 'M12.9 16.4l-2.6 3.4h2.3l-1.3 2.6'],
    snow: ['M8 14.6h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 6.6 3.9 3.9 0 0 0 8 14.6z', 'M9.2 17.4v3.2M7.8 18.2l2.8 1.6M10.6 18.2l-2.8 1.6', 'M14.8 17.4v3.2M13.4 18.2l2.8 1.6M16.2 18.2l-2.8 1.6'],
    fog: ['M8 13.6h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 5.6 3.9 3.9 0 0 0 8 13.6z', 'M5.6 17.4h12.8M7.6 20.6h8.8'],
  };

  let sequence = 0;

  // Wide mode: from Bootstrap's xl breakpoint up (xl and xxl), show this
  // many days side by side. Reads Bootstrap 5.3's --bs-breakpoint-xl so a
  // theme that changes the breakpoint is followed; 1200px otherwise.
  const WIDE_COLUMNS = 3;
  const WIDE_QUERY = '(min-width: ' + ((window.getComputedStyle && getComputedStyle(document.documentElement).getPropertyValue('--bs-breakpoint-xl').trim()) || '1200px') + ')';

  Drupal.behaviors.libcalGanttDayCarousel = {
    attach(context, settings) {
      const endpoint = (settings.libcalGanttCarousel && settings.libcalGanttCarousel.endpoint) || '/libcal-gantt/carousel-events';
      once('libcal-day-carousel', '.libcal-day-carousel', context).forEach((el) => init(el, endpoint));
    },
  };

  function readOptions(el) {
    const d = el.dataset;
    const int = (value, fallback) => {
      const n = parseInt(value, 10);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
      maxDays: Math.max(1, int(d.maxDays, 7)),
      includeWeekends: d.includeWeekends !== '0',
      onlyEventDays: d.onlyEventDays === '1',
      eventsPerSlide: Math.max(1, int(d.eventsPerSlide, 6)),
      showHours: d.showHours !== '0',
      showImages: d.showImages !== '0',
      interval: int(d.interval, 0),
      calendar: d.calendar || '',
      fullCalendarUrl: d.fullCalendarUrl || '',
      label: d.label || Drupal.t('Upcoming library days'),
    };
  }

  function init(el, endpoint) {
    const options = readOptions(el);
    let url = endpoint + (endpoint.indexOf('?') === -1 ? '?' : '&') + 'offset=0';
    if (options.calendar) {
      url += '&calendar=' + encodeURIComponent(options.calendar);
    }

    el.setAttribute('aria-busy', 'true');
    fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) {
          throw new Error('LibCal day carousel: request failed with status ' + response.status);
        }
        return response.json();
      })
      .then((data) => render(el, buildSlides(data, options), options))
      .catch((error) => {
        el.innerHTML = '';
        el.appendChild(paragraph('libcal-day-carousel__status', Drupal.t('Upcoming events are unavailable right now.')));
        console.error(error);
      })
      .finally(() => el.removeAttribute('aria-busy'));
  }

  /* ------------------------------------------------------------------
   * Data
   * ---------------------------------------------------------------- */

  function buildSlides(data, options) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const weather = isObject(data.weather) ? data.weather : {};
    const onThisDay = isObject(data.onThisDay) ? data.onThisDay : {};
    const list =(Array.isArray(data.days) ? data.days : []).map((day) => ({ day: day, weekend: null }));

    if (options.includeWeekends && Array.isArray(data.weekends)) {
      data.weekends.forEach((weekend) => {
        list.push({ day: weekend.saturday, weekend: weekend });
        list.push({ day: weekend.sunday, weekend: weekend });
      });
    }
    list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    const slides = list.map((item) => ({
      day: item.day,
      isWeekend: !!item.weekend,
      weather: weather[item.day] || null,
      hours: options.showHours ? collectHours(item.weekend ? data.weekendHours : data.hours, rows, item.day) : [],
      events: item.weekend ? weekendEvents(item.weekend, item.day) : weekdayEvents(data.events, item.day),
      // Wikipedia "On this day" list; CarouselEventsController only sends
      // it for days with no timed events (and only with the setting on).
      fact: pickFact(onThisDay[item.day]),
    }));

    if (!options.onlyEventDays) {
      return slides.slice(0, options.maxDays);
    }

    // "Show only event days": all-day items (a donation bin, an open room)
    // are dropped from every slide, then days left with no events are
    // skipped, and the first maxDays are kept. Only the fetched window is
    // searched (the parent's weekday_count weekdays plus their weekends,
    // about two weeks), so a quiet fortnight shows fewer slides rather than
    // reaching further out.
    return slides
      .map((slide) => Object.assign(slide, { events: slide.events.filter((event) => !event.allDay) }))
      .filter((slide) => slide.events.length > 0)
      .slice(0, options.maxDays);
  }

  /**
   * One "On this day" fact from a day's list, or null.
   *
   * Random per page load, like pickOnThisDayFact() in gantt-timeline.js;
   * each slide is built once, so the pick is stable for the visit.
   */
  function pickFact(facts) {
    if (!Array.isArray(facts) || !facts.length) {
      return null;
    }
    const fact = facts[Math.floor(Math.random() * facts.length)];
    return fact && typeof fact.text === 'string' && fact.text ? fact : null;
  }

  function collectHours(hoursByRow, rows, day) {
    if (!isObject(hoursByRow)) {
      return [];
    }
    return rows
      .filter((row) => isObject(hoursByRow[row]) && hoursByRow[row][day])
      .map((row) => ({ row: row, text: describeHours(hoursByRow[row][day]) }))
      .filter((entry) => entry.text !== '');
  }

  function describeHours(entry) {
    if (!entry) {
      return '';
    }
    if (entry.closed) {
      return Drupal.t('Closed');
    }
    if (typeof entry.openHour === 'number' && typeof entry.closeHour === 'number') {
      if (entry.openHour <= 0 && entry.closeHour >= 24) {
        return Drupal.t('Open 24 hours');
      }
      return formatHour(entry.openHour) + '\u2013' + formatHour(entry.closeHour);
    }
    return entry.label ? String(entry.label) : '';
  }

  function weekdayEvents(events, day) {
    return (Array.isArray(events) ? events : [])
      .filter((event) => event.segments && event.segments[day])
      .map((event) => {
        const seg = event.segments[day];
        const allDay = seg.startHour <= 0.01 && seg.endHour >= 23.9;
        return {
          title: event.title,
          url: event.url,
          location: event.location,
          image: event.image,
          imageAlt: event.imageAlt || '',
          sort: allDay ? -1 : seg.startHour,
          allDay: allDay,
          endHour: seg.endHour,
          // Times come from the day's segment, not the event's overall
          // start/end labels, so day 3 of a multi-day event reads correctly.
          time: allDay ? Drupal.t('All day') : formatHour(seg.startHour) + '\u2013' + formatHour(seg.endHour),
        };
      })
      .sort(byStart);
  }

  function weekendEvents(weekend, day) {
    const out = [];
    const byRow = isObject(weekend.events) ? weekend.events : {};
    Object.keys(byRow).forEach((row) => {
      (byRow[row] || []).forEach((event) => {
        if (event.day !== day) {
          return;
        }
        const allDay = event.startLabel === '12:00 AM' && event.endLabel === '11:59 PM';
        out.push({
          title: event.title,
          url: event.url,
          location: event.location,
          image: event.image,
          imageAlt: '',
          sort: allDay ? -1 : labelToHour(event.startLabel),
          allDay: allDay,
          endHour: allDay ? 24 : (labelToHour(event.endLabel) || 24),
          time: allDay ? Drupal.t('All day') : event.startLabel + '\u2013' + event.endLabel,
        });
      });
    });
    return out.sort(byStart);
  }

  function byStart(a, b) {
    return (a.sort - b.sort) || String(a.title).localeCompare(String(b.title));
  }

  /* ------------------------------------------------------------------
   * Rendering
   * ---------------------------------------------------------------- */

  function render(el, slides, options) {
    el.innerHTML = '';
    if (!slides.length) {
      el.appendChild(paragraph('libcal-day-carousel__status', options.onlyEventDays
        ? Drupal.t('No upcoming events in the next two weeks.')
        : Drupal.t('No upcoming days to show.')));
      return;
    }

    const id = 'libcal-day-carousel-' + (++sequence);
    const today = isoDate(new Date());
    const tomorrow = isoDate(addDays(new Date(), 1));

    const frame = make('div', 'libcal-day-carousel__frame carousel slide');
    frame.id = id;
    frame.setAttribute('aria-roledescription', Drupal.t('carousel'));
    frame.setAttribute('aria-label', options.label);

    // Toolbar: day "tabs" (Bootstrap indicators) plus prev/next.
    const toolbar = make('div', 'libcal-day-carousel__toolbar');
    const tabs = make('div', 'carousel-indicators libcal-day-carousel__tabs');
    slides.forEach((slide, index) => {
      const button = make('button', 'libcal-day-carousel__tab' + (index === 0 ? ' active' : ''));
      button.type = 'button';
      button.setAttribute('data-bs-target', '#' + id);
      button.setAttribute('data-bs-slide-to', String(index));
      button.setAttribute('aria-label', longDate(slide.day));
      if (index === 0) {
        button.setAttribute('aria-current', 'true');
      }
      button.appendChild(make('span', 'libcal-day-carousel__tab-dow', shortWeekday(slide.day, today, tomorrow)));
      button.appendChild(make('span', 'libcal-day-carousel__tab-num', String(parseDate(slide.day).getDate())));
      tabs.appendChild(button);
    });
    toolbar.appendChild(tabs);

    const controls = make('div', 'libcal-day-carousel__controls');
    controls.appendChild(controlButton(id, 'prev', Drupal.t('Previous day')));
    controls.appendChild(controlButton(id, 'next', Drupal.t('Next day')));
    toolbar.appendChild(controls);
    frame.appendChild(toolbar);

    const inner = make('div', 'carousel-inner');
    slides.forEach((slide, index) => {
      inner.appendChild(buildSlide(slide, index, slides.length, options, today, tomorrow));
    });
    frame.appendChild(inner);
    el.appendChild(frame);

    activate(el, frame, options);
    listInToc(el, frame);
  }

  function buildSlide(slide, index, total, options, today, tomorrow) {
    const item = make('div', 'carousel-item libcal-day' + (index === 0 ? ' active' : '') + (slide.day === today ? ' is-today' : '') + (slide.isWeekend ? ' is-weekend' : ''));
    item.setAttribute('role', 'group');
    item.setAttribute('aria-roledescription', Drupal.t('slide'));
    item.setAttribute('aria-label', Drupal.t('@date (@n of @total)', { '@date': longDate(slide.day), '@n': index + 1, '@total': total }));
    item.dataset.day = slide.day;

    const grid = make('div', 'libcal-day__grid');

    // Left column: date, weather, hours.
    const aside = make('div', 'libcal-day__aside');
    aside.appendChild(make('p', 'libcal-day__eyebrow', relativeLabel(slide.day, today, tomorrow)));
    aside.appendChild(make('h3', 'libcal-day__date', longDate(slide.day)));
    const weather = buildWeather(slide.weather);
    if (weather) {
      aside.appendChild(weather);
    }
    if (slide.hours.length) {
      const hours = make('dl', 'libcal-day__hours');
      slide.hours.forEach((entry) => {
        hours.appendChild(make('dt', '', entry.row));
        hours.appendChild(make('dd', '', entry.text));
      });
      aside.appendChild(hours);
    }
    grid.appendChild(aside);

    // Right column: events.
    const main = make('div', 'libcal-day__main');
    if (slide.events.length) {
      // Only a timed event's image is featured: all-day items (a donation
      // bin, an open room) are standing notices, not the day's programme.
      const featured = options.showImages ? slide.events.find((event) => event.image && !event.allDay) : null;
      if (featured) {
        const figure = make('figure', 'libcal-day__feature');
        const img = document.createElement('img');
        img.src = featured.image;
        img.alt = featured.imageAlt || '';
        img.loading = index === 0 ? 'eager' : 'lazy';
        img.decoding = 'async';
        figure.appendChild(img);
        main.appendChild(figure);
      }

      const listEl = make('ol', 'libcal-day__events');
      slide.events.slice(0, options.eventsPerSlide).forEach((event) => {
        const li = make('li', 'libcal-day__event' + (event.allDay ? ' is-all-day' : ''));
        li.dataset.day = slide.day;
        li.dataset.allDay = event.allDay ? '1' : '0';
        li.dataset.endHour = String(event.endHour);
        li.dataset.title = event.title || '';
        li.dataset.time = event.time || '';
        li.appendChild(make('span', 'libcal-day__event-time', event.time));
        const body = make('div', 'libcal-day__event-body');
        const title = event.url ? make('a', 'libcal-day__event-title', event.title) : make('span', 'libcal-day__event-title', event.title);
        if (event.url) {
          title.href = event.url;
        }
        body.appendChild(title);
        if (event.location) {
          body.appendChild(make('span', 'libcal-day__event-location', event.location));
        }
        li.appendChild(body);
        listEl.appendChild(li);
      });
      main.appendChild(listEl);

      const remaining = slide.events.length - options.eventsPerSlide;
      if (remaining > 0 && options.fullCalendarUrl) {
        const more = make('p', 'libcal-day__more');
        const link = make('a', '', Drupal.formatPlural(remaining, '1 more event on the full calendar', '@count more events on the full calendar'));
        link.href = options.fullCalendarUrl;
        more.appendChild(link);
        main.appendChild(more);
      }
    }
    else {
      main.appendChild(paragraph('libcal-day__empty', Drupal.t('No events scheduled.')));
    }
    // Quiet day (no timed events): the "On this day" fact comes last, after
    // the day's events (or "No events scheduled."), as a small aside. It is
    // a fun add-on, not the day's programme, so it no longer takes the
    // feature slot at the top.
    if (slide.fact) {
      main.appendChild(buildFact(slide.fact));
    }
    grid.appendChild(main);
    item.appendChild(grid);
    return item;
  }

  /**
   * A Wikipedia "On this day" anniversary for a quiet day.
   *
   * Same content and wording as buildHomepageFact() in gantt-timeline.js:
   * a block with its own visible label, never in the event list, so it
   * can't be mistaken for something happening at the library. A plain div,
   * not an <aside>: up to three days show at once, and three complementary
   * landmarks would only add noise. Every string goes in through
   * textContent. The source link is the CC BY-SA attribution, so it is
   * required; its accessible name says where it goes.
   */
  function buildFact(fact) {
    const wrap = make('div', 'libcal-day__fact');
    const year = typeof fact.year === 'number' && isFinite(fact.year) ? fact.year : null;
    let label;
    if (year === null) {
      label = Drupal.t('On this day');
    }
    else if (year < 0) {
      label = Drupal.t('On this day in @year BC', { '@year': String(Math.abs(year)) });
    }
    else {
      label = Drupal.t('On this day in @year', { '@year': String(year) });
    }
    wrap.appendChild(paragraph('libcal-day__fact-label', label));
    wrap.appendChild(paragraph('libcal-day__fact-text', fact.text));

    if (typeof fact.url === 'string' && /^https:\/\/en\.wikipedia\.org\//.test(fact.url)) {
      const link = make('a', 'libcal-day__fact-source', Drupal.t('Wikipedia'));
      link.href = fact.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', fact.title
        ? Drupal.t('Read about @title on Wikipedia (opens in a new tab)', { '@title': fact.title })
        : Drupal.t('Read more on Wikipedia (opens in a new tab)'));
      wrap.appendChild(link);
    }
    return wrap;
  }

  function buildWeather(entry) {
    if (!entry) {
      return null;
    }
    const hasHigh = typeof entry.high === 'number';
    const hasLow = typeof entry.low === 'number';
    const condition = String(entry.condition || '');
    if (!condition && !hasHigh && !hasLow) {
      return null;
    }

    const wrap = make('div', 'libcal-day__weather');
    const icon = buildWeatherIcon(entry.icon);
    if (icon) {
      wrap.appendChild(icon);
    }
    if (hasHigh || hasLow) {
      const temps = make('span', 'libcal-day__temps');
      if (hasHigh) {
        temps.appendChild(make('span', 'libcal-day__high', Math.round(entry.high) + '\u00b0'));
      }
      if (hasLow) {
        temps.appendChild(make('span', 'libcal-day__low', (hasHigh ? ' / ' : '') + Math.round(entry.low) + '\u00b0'));
      }
      wrap.appendChild(temps);
    }
    const text = [condition];
    if (typeof entry.pop === 'number' && entry.pop >= WEATHER_POP_THRESHOLD) {
      text.push(Drupal.t('@pop% chance of precipitation', { '@pop': Math.round(entry.pop) }));
    }
    wrap.appendChild(make('span', 'libcal-day__condition', text.filter(Boolean).join(' \u00b7 ')));
    return wrap;
  }

  function buildWeatherIcon(key) {
    const paths = WEATHER_ICON_PATHS[String(key || '')];
    if (!paths) {
      return null;
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'libcal-day__weather-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    paths.forEach((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  // The chevron is an inline SVG in currentColor, not Bootstrap's
  // .carousel-control-*-icon. Bootstrap draws that icon as a white
  // background image and, under data-bs-theme="dark", runs it through
  // invert(1), which turned it black on the dark section.
  const CHEVRONS = { prev: 'M10 3L5 8l5 5', next: 'M6 3l5 5-5 5' };

  function controlButton(id, direction, label) {
    const button = make('button', 'carousel-control-' + direction + ' libcal-day-carousel__control');
    button.type = 'button';
    button.setAttribute('data-bs-target', '#' + id);
    button.setAttribute('data-bs-slide', direction);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'libcal-day-carousel__chevron');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', CHEVRONS[direction]);
    svg.appendChild(path);
    button.appendChild(svg);
    button.appendChild(make('span', 'visually-hidden', label));
    return button;
  }

  /**
   * Starts Bootstrap's carousel. Without Bootstrap (e.g. under Origami),
   * falls back to a horizontal scroll-snap strip.
   */
  function activate(el, frame, options) {
    const Carousel = window.bootstrap && window.bootstrap.Carousel;
    if (!Carousel) {
      el.classList.add('is-static');
      return;
    }
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let autoplay = options.interval > 0 && !reduceMotion;
    const config = {
      interval: autoplay ? options.interval : false,
      ride: autoplay ? 'carousel' : false,
      keyboard: true,
      touch: true,
      pause: 'hover',
      wrap: false,
    };
    Carousel.getOrCreateInstance(frame, config);

    const prev = frame.querySelector('[data-bs-slide="prev"]');
    const next = frame.querySelector('[data-bs-slide="next"]');
    const items = Array.from(frame.querySelectorAll('.carousel-item'));
    const tabs = Array.from(frame.querySelectorAll('.libcal-day-carousel__tab'));
    const count = items.length;

    // Wide mode (xl and xxl): several days side by side, one per column.
    // Bootstrap still owns the state (active day, tabs, buttons, swipe,
    // keys). The active day is the leftmost column, and CSS slides every
    // column by --ldc-start, so each step moves the view by one day.
    // `maxStart` keeps the view full: on the last view the final day sits
    // in the right-hand column.
    const wide = window.matchMedia(WIDE_QUERY);
    let multi = false;
    let maxStart = count - 1;

    const activeIndex = () => Math.max(0, items.findIndex((item) => item.classList.contains('active')));

    // Bootstrap doesn't disable the buttons when wrap is false, so do it
    // here. A disabled "Previous" on the first day is clearer than a no-op.
    const sync = (index) => {
      prev.disabled = index <= 0;
      next.disabled = index >= maxStart;
    };

    // Shows columns start .. start + cols - 1. Columns outside the view are
    // `inert`, so their links can't be tabbed to (the browser would scroll
    // the clipped strip to reveal them) and screen readers skip them.
    const cols = () => (multi ? Math.min(WIDE_COLUMNS, count) : 1);
    const applyView = (start) => {
      frame.style.setProperty('--ldc-start', String(multi ? start : 0));
      items.forEach((item, i) => {
        const inView = !multi || (i >= start && i < start + cols());
        item.inert = !inView;
        // The first column in view hides its left border (CSS fades it),
        // so only the borders between the columns in view show.
        item.classList.toggle('is-first-in-view', multi && i === start);
        if (tabs[i]) {
          tabs[i].classList.toggle('is-in-view', multi && inView);
        }
      });
    };

    // Moves without the slide animation (mode switches on resize).
    const instant = (fn) => {
      frame.classList.add('is-instant');
      fn();
      void frame.offsetWidth;
      window.requestAnimationFrame(() => frame.classList.remove('is-instant'));
    };

    const setMode = () => {
      multi = wide.matches && count > 1;
      maxStart = multi ? Math.max(0, count - cols()) : count - 1;
      el.classList.toggle('is-multi', multi);
      frame.style.setProperty('--ldc-cols', String(cols()));
      const index = activeIndex();
      if (index > maxStart) {
        // e.g. widening the window while the last day is showing.
        instant(() => Carousel.getOrCreateInstance(frame).to(maxStart));
        instant(() => applyView(maxStart));
      }
      else {
        instant(() => applyView(index));
      }
      sync(Math.min(index, maxStart));
    };
    setMode();
    if (wide.addEventListener) {
      wide.addEventListener('change', setMode);
    }
    else if (wide.addListener) {
      wide.addListener(setMode);
    }

    frame.addEventListener('slide.bs.carousel', (event) => {
      if (multi && event.to > maxStart) {
        // A tab for one of the last days, or Next/Right on the last view:
        // show the last full view instead. A no-op when it's already shown.
        event.preventDefault();
        window.setTimeout(() => {
          const instance = Carousel.getInstance(frame);
          if (instance) {
            instance.to(maxStart);
          }
        }, 0);
        return;
      }
      applyView(event.to);
    });

    // Polite live region. Only user-initiated changes are announced, so
    // autoplay never talks over a screen reader (WAI-ARIA APG carousel).
    const live = make('div', 'visually-hidden');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    el.appendChild(live);

    // Anything the user does inside the carousel (buttons, arrow keys while
    // a tab or button has focus, touch swipe) marks the next slide change
    // as user-initiated. The section-wide key handler below marks it too.
    const markUser = () => {
      frame.dataset.userSlideAt = String(Date.now());
    };
    frame.addEventListener('click', markUser, true);
    frame.addEventListener('pointerdown', markUser, true);
    frame.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        markUser();
      }
    }, true);

    const announce = (index) => {
      if (!multi) {
        return items[index] ? items[index].getAttribute('aria-label') : '';
      }
      const last = Math.min(count - 1, index + cols() - 1);
      return Drupal.t('Showing @first to @last (days @n\u2013@m of @total)', {
        '@first': longDate(items[index].dataset.day),
        '@last': longDate(items[last].dataset.day),
        '@n': index + 1,
        '@m': last + 1,
        '@total': count,
      });
    };

    frame.addEventListener('slid.bs.carousel', (event) => {
      sync(event.to);
      // If focus was on a link in a column that just left the view, move it
      // to the tab of the new first day instead of losing it to <body>.
      const focused = document.activeElement;
      if (focused && focused.closest && focused.closest('.carousel-item[inert]') && tabs[event.to]) {
        tabs[event.to].focus();
      }
      const at = parseInt(frame.dataset.userSlideAt || '0', 10);
      if (Date.now() - at > USER_SLIDE_WINDOW) {
        return;
      }
      delete frame.dataset.userSlideAt;
      live.textContent = announce(event.to);
      // Once someone navigates by hand, autoplay stays off for good.
      // Bootstrap's own pause only lasts until the pointer leaves, so the
      // instance is recreated without an interval.
      if (autoplay) {
        autoplay = false;
        window.setTimeout(() => {
          const instance = Carousel.getInstance(frame);
          if (instance) {
            instance.pause();
            instance.dispose();
          }
          Carousel.getOrCreateInstance(frame, Object.assign({}, config, { interval: false, ride: false }));
        }, 0);
      }
    });
  }

  /**
   * Section-wide arrow keys (Palefire modular pages only).
   *
   * Bootstrap's `keyboard: true` only reacts while focus is inside the
   * carousel. On a modular page, Left/Right also change the day whenever
   * the carousel's section is the active one in the table of contents
   * (body[data-active-section], set by palefire/js/modular-toc.js) and on
   * screen. This gives keyboard users the same "swipe" a touchscreen gets
   * without having to tab into the carousel first.
   *
   * Left alone so nothing else breaks:
   * - modifier keys (Alt+Left is browser Back), and already-handled events;
   * - typing in inputs, textareas, selects and contenteditable regions;
   * - widgets that own their arrow keys (tabs, menus, sliders, listboxs…);
   * - open dialogs, modals and the mobile "On this page" offcanvas;
   * - focus inside the carousel itself, which Bootstrap already handles.
   * Up/Down are never touched, so page scrolling and scroll-snap work as
   * normal. Screen readers in browse mode consume arrow keys before the
   * page sees them, so this does not interfere with reading.
   *
   * One listener for the whole document, resolved at keypress time, so it
   * keeps working (and doesn't leak) across Swup page swaps.
   */
  const USER_SLIDE_WINDOW = 1500;
  const ARROW_WIDGETS = [
    'input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])',
    '[role="tablist"]', '[role="tab"]', '[role="menu"]', '[role="menubar"]', '[role="menuitem"]',
    '[role="listbox"]', '[role="option"]', '[role="slider"]', '[role="spinbutton"]',
    '[role="radiogroup"]', '[role="radio"]', '[role="grid"]', '[role="tree"]', '[role="combobox"]',
    '[role="textbox"]', '[role="toolbar"]', 'video', 'audio',
  ].join(',');
  const OVERLAYS = 'dialog[open], [aria-modal="true"], .modal.show, .offcanvas.show, .offcanvas-lg.show';

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target && (target.closest(ARROW_WIDGETS) || target.closest(OVERLAYS))) {
      return;
    }
    if (document.querySelector('.modal.show, dialog[open]')) {
      return;
    }

    const activeId = document.body && document.body.dataset.activeSection;
    const Carousel = window.bootstrap && window.bootstrap.Carousel;
    if (!activeId || !Carousel) {
      return;
    }
    const section = document.getElementById(activeId);
    const frame = section && section.querySelector('.libcal-day-carousel__frame.carousel');
    if (!frame || (target && frame.contains(target))) {
      return;
    }
    // Guards against a stale id (e.g. after a Swup swap) or a section that
    // has scrolled away before the TOC updated.
    const rect = section.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      return;
    }
    const instance = Carousel.getInstance(frame);
    if (!instance) {
      return;
    }

    event.preventDefault();
    frame.dataset.userSlideAt = String(Date.now());
    const rtl = (frame.closest('[dir]') || document.documentElement).getAttribute('dir') === 'rtl';
    const forward = (event.key === 'ArrowRight') !== rtl;
    if (forward) {
      instance.next();
    }
    else {
      instance.prev();
    }
  });

  /* ------------------------------------------------------------------
   * "On this page" links (Palefire modular pages)
   * ---------------------------------------------------------------- */

  /**
   * Lists the next few timed events under the calendar's entry in the
   * "On this page" table of contents, the way the TOC lists a section's
   * h3s.
   *
   * - Picks the first TOC_EVENTS events in day order that are not all-day
   *   and have not ended yet. Only events shown on a slide count (see
   *   "Events per day").
   * - Marks each one with data-toc (label: data-toc-label, extra screen
   *   reader text: data-toc-detail) and data-toc-passive, so the TOC lists
   *   it but doesn't highlight it by scroll position. The columns sit side
   *   by side, so "which one is under the line" means nothing here.
   * - The block root gets data-toc-skip, so the day headings (h3) stay
   *   out of the TOC at every depth.
   * - The slides are built after the TOC, so this fires
   *   `palefire:tocrefresh` and palefire/js/modular-toc.js rebuilds the
   *   section's sub-list. Without the Palefire TOC nothing listens and the
   *   attributes do nothing.
   *
   * Change the number with data-toc-events on the block wrapper
   * (0 turns it off).
   */
  const TOC_EVENTS = 3;

  function listInToc(el, frame) {
    el.setAttribute('data-toc-skip', '');
    const wanted = el.dataset.tocEvents !== undefined ? parseInt(el.dataset.tocEvents, 10) : TOC_EVENTS;
    if (!(wanted > 0)) {
      return;
    }
    const now = new Date();
    const today = isoDate(now);
    const hourNow = now.getHours() + now.getMinutes() / 60;
    const picked = [];
    const events = frame.querySelectorAll('.libcal-day__event');
    for (let i = 0; i < events.length && picked.length < wanted; i++) {
      const li = events[i];
      const day = li.dataset.day || '';
      if (li.dataset.allDay === '1' || day < today) {
        continue;
      }
      if (day === today && parseFloat(li.dataset.endHour) <= hourNow) {
        continue;
      }
      picked.push(li);
    }
    picked.forEach((li, n) => {
      li.id = frame.id + '-event-' + (n + 1);
      li.setAttribute('data-toc', '');
      li.setAttribute('data-toc-passive', '');
      li.setAttribute('tabindex', '-1');
      li.dataset.tocLabel = li.dataset.title || li.textContent.trim();
      li.dataset.tocDetail = parseDate(li.dataset.day).toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' }) + ', ' + (li.dataset.time || '');
    });
    if (picked.length) {
      el.dispatchEvent(new CustomEvent('palefire:tocrefresh', { bubbles: true }));
    }
  }

  /**
   * Jumps to an event from a link to its id (the TOC sub-links above, or
   * any other #link). A plain anchor jump can't reach a day outside the
   * view: the browser would scroll the clipped strip sideways and break
   * the layout. So the carousel moves to that day first, then the page
   * scrolls down to the event and focus moves to its title link.
   *
   * Capture phase, so it runs before Bootstrap and before the TOC's own
   * click handler (which still marks the link active).
   */
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null;
    if (!link || link.hash.length < 2) {
      return;
    }
    let target = null;
    try {
      target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    }
    catch (e) {
      return;
    }
    if (!target || !target.classList.contains('libcal-day__event') || !target.closest('.libcal-day-carousel__frame')) {
      return;
    }
    event.preventDefault();
    revealEvent(target);
  }, true);

  function revealEvent(li) {
    const frame = li.closest('.libcal-day-carousel__frame');
    const item = li.closest('.carousel-item');
    const items = Array.from(frame.querySelectorAll('.carousel-item'));
    const index = items.indexOf(item);
    const multi = !!frame.closest('.libcal-day-carousel.is-multi');
    const inView = multi ? !item.inert : item.classList.contains('active');
    const Carousel = window.bootstrap && window.bootstrap.Carousel;
    const instance = Carousel ? Carousel.getInstance(frame) : null;
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pf-header-h')) || 0;
      const top = li.getBoundingClientRect().top + window.scrollY - header - 16;
      window.scrollTo({ top: Math.max(0, top), behavior: reduceMotion ? 'auto' : 'smooth' });
      const focusable = li.querySelector('a[href]') || li;
      focusable.focus({ preventScroll: true });
    };

    if (inView || index < 0) {
      finish();
      return;
    }
    if (!instance) {
      // Scroll-snap fallback (no Bootstrap JS): bring the day into the strip.
      const strip = item.parentElement;
      strip.scrollTo({ left: item.offsetLeft - strip.offsetLeft, behavior: reduceMotion ? 'auto' : 'smooth' });
      finish();
      return;
    }
    // A user action: it is announced and stops autoplay (see activate()).
    frame.dataset.userSlideAt = String(Date.now());
    frame.addEventListener('slid.bs.carousel', () => window.requestAnimationFrame(finish), { once: true });
    window.setTimeout(finish, 1500);
    instance.to(index);
  }

  /* ------------------------------------------------------------------
   * Helpers
   * ---------------------------------------------------------------- */

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) {
      el.className = className;
    }
    if (text !== undefined) {
      el.textContent = text;
    }
    return el;
  }

  function paragraph(className, text) {
    return make('p', className, text);
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function parseDate(ymd) {
    const parts = String(ymd).split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function isoDate(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function addDays(date, n) {
    const copy = new Date(date);
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  function locale() {
    return document.documentElement.lang || 'en-US';
  }

  function longDate(ymd) {
    return parseDate(ymd).toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function shortWeekday(ymd, today, tomorrow) {
    if (ymd === today) {
      return Drupal.t('Today');
    }
    return parseDate(ymd).toLocaleDateString(locale(), { weekday: 'short' });
  }

  function relativeLabel(ymd, today, tomorrow) {
    if (ymd === today) {
      return Drupal.t('Today');
    }
    if (ymd === tomorrow) {
      return Drupal.t('Tomorrow');
    }
    return parseDate(ymd).toLocaleDateString(locale(), { weekday: 'long' });
  }

  /** 9.5 -> "9:30 AM", 13 -> "1 PM", 24 -> "12 AM". */
  function formatHour(fraction) {
    let hour = Math.floor(fraction);
    let minute = Math.round((fraction - hour) * 60);
    if (minute === 60) {
      hour += 1;
      minute = 0;
    }
    const suffix = (hour % 24) >= 12 ? 'PM' : 'AM';
    const h12 = (hour % 12) || 12;
    return h12 + (minute ? ':' + String(minute).padStart(2, '0') : '') + '\u00a0' + suffix;
  }

  function labelToHour(label) {
    const match = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(String(label || '').trim());
    if (!match) {
      return 0;
    }
    let hour = parseInt(match[1], 10) % 12;
    if (match[3].toUpperCase() === 'PM') {
      hour += 12;
    }
    return hour + parseInt(match[2], 10) / 60;
  }
})(Drupal, drupalSettings, once);
