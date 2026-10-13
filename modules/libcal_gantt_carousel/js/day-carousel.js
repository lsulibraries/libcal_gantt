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
    const list = (Array.isArray(data.days) ? data.days : []).map((day) => ({ day: day, weekend: null }));

    if (options.includeWeekends && Array.isArray(data.weekends)) {
      data.weekends.forEach((weekend) => {
        list.push({ day: weekend.saturday, weekend: weekend });
        list.push({ day: weekend.sunday, weekend: weekend });
      });
    }
    list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    return list.slice(0, options.maxDays).map((item) => ({
      day: item.day,
      isWeekend: !!item.weekend,
      weather: weather[item.day] || null,
      hours: options.showHours ? collectHours(item.weekend ? data.weekendHours : data.hours, rows, item.day) : [],
      events: item.weekend ? weekendEvents(item.weekend, item.day) : weekdayEvents(data.events, item.day),
    }));
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
      el.appendChild(paragraph('libcal-day-carousel__status', Drupal.t('No upcoming days to show.')));
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
      const featured = options.showImages ? slide.events.find((event) => event.image) : null;
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
        const li = make('li', 'libcal-day__event');
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
    grid.appendChild(main);
    item.appendChild(grid);
    return item;
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

  function controlButton(id, direction, label) {
    const button = make('button', 'carousel-control-' + direction + ' libcal-day-carousel__control');
    button.type = 'button';
    button.setAttribute('data-bs-target', '#' + id);
    button.setAttribute('data-bs-slide', direction);
    button.appendChild(make('span', 'carousel-control-' + direction + '-icon')).setAttribute('aria-hidden', 'true');
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
    const autoplay = options.interval > 0 && !reduceMotion;
    Carousel.getOrCreateInstance(frame, {
      interval: autoplay ? options.interval : false,
      ride: autoplay ? 'carousel' : false,
      keyboard: true,
      touch: true,
      pause: 'hover',
      wrap: false,
    });

    // Bootstrap toggles `disabled` on nothing when wrap is false, so do it
    // here. A disabled "Previous" on the first day is clearer than a no-op.
    const prev = frame.querySelector('[data-bs-slide="prev"]');
    const next = frame.querySelector('[data-bs-slide="next"]');
    const count = frame.querySelectorAll('.carousel-item').length;
    const sync = (index) => {
      prev.disabled = index <= 0;
      next.disabled = index >= count - 1;
    };
    sync(0);
    frame.addEventListener('slid.bs.carousel', (event) => sync(event.to));
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
