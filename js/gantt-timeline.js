/**
 * @file
 * Renders the LibCal events Gantt-style timeline.
 *
 * All timezone-sensitive math (which weekday a segment belongs to, what
 * hour-of-day it starts/ends, building open/close hours) is done
 * server-side in GanttEventsController; this file only positions the
 * numbers it's given, so it stays simple and never has to reason about
 * timezones itself.
 */
(function (Drupal, drupalSettings, once) {
  'use strict';

  /**
   * How many day columns the wide-screen grid shows per "row block." Per
   * the user's request, "Show more" no longer grows the table wider -
   * once more days than this are loaded, additional days start a new
   * block of rows underneath instead, with the day-header row (and
   * every location's row header) repeated for that block. See
   * buildGrid(). Keeps the table from ever getting wider than a
   * comfortable read, no matter how many "show more" clicks have
   * accumulated.
   */
  const GRID_DAYS_PER_ROW = 5;

  /**
   * How often the chart silently re-renders itself from data it already
   * has (no network request - see the setInterval() call in initChart()
   * and renderChart()) so that everything computed relative to "right
   * now" - which day counts as `past_date`, whether a row is `now_open`/
   * `now_closed`, and the Opens/Opened/Closes/Closed tense of the hours
   * captions - stays correct if the page is left open across the moment
   * one of those needs to change (an opening/closing time, or
   * midnight). This is unrelated to the "no client-side polling/auto-
   * refresh" limitation noted in the README, which is about re-fetching
   * EVENT data from the server - this never calls fetch(), it only
   * recomputes time-relative state and redraws from what's already in
   * memory.
   */
  const LIVE_REFRESH_INTERVAL_MS = 60000;

  Drupal.behaviors.libcalGanttChart = {
    attach(context, settings) {
      once('libcal-gantt-chart', '.libcal-gantt-chart', context).forEach((container) => {
        const endpoint = (settings.libcalGantt && settings.libcalGantt.endpoint) || '/libcal-gantt/events';
        initChart(container, endpoint);
      });
    },
  };

  /**
   * Chart state accumulates across "show more" clicks - each click asks
   * the server for the next page of weekdays and the results are merged
   * in here, then the whole chart is re-rendered from the merged state.
   * Rebuilding from scratch each time (rather than patching the DOM) is
   * simpler and cheap enough at this scale.
   */
  function initChart(container, endpoint) {
    const state = {
      days: [],
      events: [],
      // Keyed by row label, then by Y-m-d date - each row can have its
      // own Hours feed configured server-side (see "Location rows" in
      // the settings form), so this is no longer one shared hours object
      // for the whole chart.
      hours: {},
      // The row roster (location names, in display order) is server
      // config, not something discovered from event data - see
      // buildRows(). It's the same on every page, so it's just
      // overwritten (not merged/appended) each time a response comes in.
      rowLabels: [],
      dayStartHour: 8,
      dayEndHour: 21,
      pageSize: 0,
      loading: false,
      // The configured "Calendars" tabs (see the settings form) and
      // which one is currently selected - both come from the server on
      // every response (calendars[]/calendar), not configured here, so
      // the front end never has to know calendar IDs itself. calendarId
      // starts null so the very first request omits ?calendar= entirely
      // and the server picks its own default (the first configured
      // tab) - see loadPage()/switchCalendar().
      calendars: [],
      calendarId: null,
    };

    loadPage(container, endpoint, state, true);

    // See LIVE_REFRESH_INTERVAL_MS - a periodic local re-render, not a
    // data refresh, so it's safe to leave running for as long as the
    // page/tab stays open.
    setInterval(() => {
      if (!state.loading && state.days.length) {
        renderChart(container, endpoint, state);
      }
    }, LIVE_REFRESH_INTERVAL_MS);
  }

  function loadPage(container, endpoint, state, isFirstLoad) {
    if (state.loading) {
      return;
    }
    state.loading = true;

    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(loadingMessage());
    }
    else {
      setMoreButtonState(container, { loading: true });
    }

    const separator = endpoint.indexOf('?') === -1 ? '?' : '&';
    let url = endpoint + separator + 'offset=' + state.days.length;
    if (state.calendarId) {
      url += '&calendar=' + encodeURIComponent(state.calendarId);
    }

    fetch(url, { headers: { Accept: 'application/json' } })
      .then((response) => {
        if (!response.ok) {
          throw new Error('LibCal Gantt: request failed with status ' + response.status);
        }
        return response.json();
      })
      .then((data) => {
        state.loading = false;
        mergeData(state, data);
        renderChart(container, endpoint, state);
      })
      .catch((error) => {
        state.loading = false;
        if (isFirstLoad) {
          container.innerHTML = '';
          container.appendChild(errorMessage());
        }
        else {
          setMoreButtonState(container, { loading: false, error: true });
        }
        // eslint-disable-next-line no-console
        console.error(error);
      });
  }

  /**
   * Switches to a different configured calendar tab. Unlike "Show more"
   * (which extends the currently-loaded days), this discards whatever
   * days/events/hours are already loaded and starts over from the first
   * page for the new calendar - the day range and its "Show more"
   * progress don't carry over between tabs, matching how switching a
   * browser tab shows a fresh view rather than picking up mid-scroll
   * from wherever the other tab was left. Building hours are keyed by
   * location row, not by calendar, so `state.hours` would in principle
   * still be valid - it's cleared anyway for a clean, predictable full
   * reset (the very next fetch repopulates it immediately either way).
   */
  function switchCalendar(container, endpoint, state, calendarId) {
    if (state.loading || calendarId === state.calendarId) {
      return;
    }
    state.calendarId = calendarId;
    state.days = [];
    state.events = [];
    state.hours = {};
    loadPage(container, endpoint, state, true);
  }

  function mergeData(state, data) {
    const newDays = Array.isArray(data.days) ? data.days : [];
    const newEvents = Array.isArray(data.events) ? data.events : [];
    const newHours = data.hours && typeof data.hours === 'object' ? data.hours : {};

    state.pageSize = newDays.length || state.pageSize;
    if (typeof data.dayStartHour === 'number') {
      state.dayStartHour = data.dayStartHour;
    }
    if (typeof data.dayEndHour === 'number') {
      state.dayEndHour = data.dayEndHour;
    }
    if (Array.isArray(data.rows)) {
      state.rowLabels = data.rows;
    }
    if (Array.isArray(data.calendars)) {
      state.calendars = data.calendars;
    }
    if (typeof data.calendar === 'string' && data.calendar) {
      // Confirms/records which tab the server actually served - matters
      // on the very first load, when the request omitted ?calendar= and
      // the server picked the default itself; every later request (page
      // 2+, or after switching tabs) already knows and sends it.
      state.calendarId = data.calendar;
    }

    const existingDays = new Set(state.days);
    newDays.forEach((day) => {
      if (!existingDays.has(day)) {
        state.days.push(day);
      }
    });

    state.events = state.events.concat(newEvents);

    // newHours is { rowLabel: { day: {...} } } - merge one level deeper
    // than Object.assign would, so a later page's days for a row don't
    // wipe out that row's days from an earlier page.
    Object.keys(newHours).forEach((rowLabel) => {
      if (!state.hours[rowLabel]) {
        state.hours[rowLabel] = {};
      }
      Object.assign(state.hours[rowLabel], newHours[rowLabel]);
    });
  }

  function renderChart(container, endpoint, state) {
    container.innerHTML = '';

    const tabs = buildCalendarTabs(container, endpoint, state);
    if (tabs) {
      container.appendChild(tabs);
    }

    if (!state.days.length) {
      container.appendChild(emptyMessage(Drupal.t('No upcoming dates to display.')));
      return;
    }

    const rows = buildRows(state.rowLabels, state.events);
    const scale = { dayStartHour: state.dayStartHour, dayEndHour: state.dayEndHour, hours: state.hours };

    // Both views are rendered up front and CSS media queries decide which
    // one is visible. That keeps the swap instant on rotation/resize with
    // no resize listener, and both stay in sync with the same data.
    container.appendChild(buildGrid(state.days, rows, scale));
    container.appendChild(buildAgenda(state.days, state.events, state.hours, state.rowLabels));
    container.appendChild(buildMoreButton(container, endpoint, state));
  }

  /**
   * Builds the row of tab-styled buttons for switching between
   * configured "Calendars" (see the settings form), or returns null to
   * render nothing when there's only zero/one calendar configured -
   * there's nothing to switch between, so a single lonely tab would just
   * be clutter.
   *
   * Rendered as plain buttons with baseline ARIA tab roles (role="tablist"
   * / role="tab" / aria-selected) for screen readers, rather than a full
   * WAI-ARIA tabs widget with roving-tabindex arrow-key navigation - each
   * tab is already a native, focusable, Enter/Space-activatable <button>,
   * which covers keyboard use without the extra interaction-pattern code.
   *
   * Clicking a tab discards whatever's currently loaded and starts over
   * from that calendar's first page - see switchCalendar().
   */
  function buildCalendarTabs(container, endpoint, state) {
    if (!Array.isArray(state.calendars) || state.calendars.length < 2) {
      return null;
    }

    const tabs = document.createElement('div');
    tabs.className = 'libcal-gantt-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', Drupal.t('Calendar'));

    state.calendars.forEach((calendar) => {
      const isActive = calendar.id === state.calendarId;

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'libcal-gantt-tabs__tab' + (isActive ? ' is-active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.textContent = calendar.label;
      tab.addEventListener('click', () => {
        switchCalendar(container, endpoint, state, calendar.id);
      });

      tabs.appendChild(tab);
    });

    return tabs;
  }

  /**
   * Builds the wide-screen view: one column per weekday, one row per
   * location, at most GRID_DAYS_PER_ROW day columns wide. Each event is
   * a full-width bar; when a location has more than one event on the
   * same day they stack vertically in start-time order (earliest on
   * top) rather than being positioned/scaled by time of day - simpler
   * to read at a glance than a true time axis, and it never has two
   * events overlapping each other illegibly. Building hours (when
   * configured) show as small "Opens"/"Closes"/"Closed" captions
   * bracketing that row's events for the day - see
   * appendOpeningCaption()/appendClosingCaption(). Hours are per ROW now
   * (each location row can have its own Hours feed - see "Location
   * rows" in the settings form), not shared across the whole chart, so
   * the day-header row itself no longer shows an hours line - it can't
   * represent more than one row's hours at once.
   *
   * Beyond GRID_DAYS_PER_ROW accumulated days, "Show more" grows this
   * view downward rather than sideways: the days are split into blocks
   * of GRID_DAYS_PER_ROW, and each block gets its own header row (corner
   * + day headers) and its own copy of every location's row, stacked
   * below the previous block - a fresh "table" every block rather than
   * one that keeps getting wider. A short final block (fewer than
   * GRID_DAYS_PER_ROW real days left) is padded out to the full column
   * count with blank cells (buildPaddingCell()) so every block lines up
   * on the same grid columns; without that padding, CSS grid's
   * auto-placement would flow a short block's leftover cells into the
   * start of the next block's row instead of starting that row fresh.
   */
  function buildGrid(days, rows, scale) {
    const grid = document.createElement('div');
    grid.className = 'libcal-gantt';
    grid.style.setProperty('--libcal-gantt-days', String(GRID_DAYS_PER_ROW));
    grid.setAttribute('role', 'table');
    grid.setAttribute('aria-label', Drupal.t('Upcoming events'));

    if (!rows.length) {
      // Nothing row-based to repeat per block below, so just one header
      // plus one message, regardless of how many days are loaded.
      grid.appendChild(headerCell('libcal-gantt__corner', ''));
      for (let col = 0; col < GRID_DAYS_PER_ROW; col++) {
        grid.appendChild(days[col] ? buildDayHeaderCell(days[col]) : buildPaddingCell('libcal-gantt__day-header'));
      }
      const empty = document.createElement('div');
      empty.className = 'libcal-gantt__empty-row';
      empty.style.gridColumn = '1 / span ' + (GRID_DAYS_PER_ROW + 1);
      empty.textContent = Drupal.t('No events scheduled in this window.');
      grid.appendChild(empty);
      return grid;
    }

    const chunks = [];
    for (let i = 0; i < days.length; i += GRID_DAYS_PER_ROW) {
      chunks.push(days.slice(i, i + GRID_DAYS_PER_ROW));
    }

    // A row's "open right now" status is about the current moment, not
    // about which block of days happens to be on screen, so it's the
    // same for every repeated copy of that row's header - computed once
    // here rather than per block.
    const rowStatus = {};
    rows.forEach((row) => {
      rowStatus[row.label] = computeRowOpenStatus(row.label, scale.hours);
    });

    chunks.forEach((chunkDays) => {
      grid.appendChild(headerCell('libcal-gantt__corner', ''));
      for (let col = 0; col < GRID_DAYS_PER_ROW; col++) {
        grid.appendChild(chunkDays[col] ? buildDayHeaderCell(chunkDays[col]) : buildPaddingCell('libcal-gantt__day-header'));
      }

      rows.forEach((row) => {
        const rowHeader = document.createElement('div');
        rowHeader.className = 'libcal-gantt__row-header';
        const status = rowStatus[row.label];
        if (status === 'open') {
          rowHeader.classList.add('now_open');
        }
        else if (status === 'closed') {
          rowHeader.classList.add('now_closed');
        }
        rowHeader.textContent = row.label;
        grid.appendChild(rowHeader);

        const rowHours = scale.hours[row.label] || {};

        for (let col = 0; col < GRID_DAYS_PER_ROW; col++) {
          const day = chunkDays[col];
          if (!day) {
            grid.appendChild(buildPaddingCell('libcal-gantt__day-cell'));
            continue;
          }

          const dayCell = document.createElement('div');
          dayCell.className = 'libcal-gantt__day-cell';
          dayCell.dataset.date = day;
          if (dayStatus(day) === 'past') {
            dayCell.classList.add('past_date');
          }

          const dayHours = rowHours[day];

          // Opening caption (or "Closed") goes in first, so it lands at
          // the top of the cell's stacked flex column, ahead of any
          // real events - see the function doc for why this replaced
          // the old proportional shading.
          appendOpeningCaption(dayCell, dayHours, day);

          const dayEvents = row.events
            .filter((event) => event.segments && event.segments[day])
            .sort((a, b) => a.segments[day].startHour - b.segments[day].startHour);

          dayEvents.forEach((event) => {
            dayCell.appendChild(buildBar(event));
          });

          // Closing caption is appended last, deliberately after the
          // events loop above, so it lands at the bottom of the stack.
          appendClosingCaption(dayCell, dayHours, day);

          grid.appendChild(dayCell);
        }
      });
    });

    return grid;
  }

  function buildDayHeaderCell(day) {
    const cell = document.createElement('div');
    cell.className = 'libcal-gantt__day-header';
    if (dayStatus(day) === 'past') {
      cell.classList.add('past_date');
    }

    const dateLine = document.createElement('div');
    dateLine.className = 'libcal-gantt__day-header-date';
    dateLine.textContent = formatDayLabel(day, false);
    cell.appendChild(dateLine);

    return cell;
  }

  /**
   * A blank cell used to pad a short block of days out to
   * GRID_DAYS_PER_ROW columns - see buildGrid(). Carries the same base
   * class as a real cell so it still occupies a normal grid track, plus
   * a `--empty` modifier (see gantt-timeline.css) that clears its
   * border/background so it reads as empty space rather than a stray
   * box.
   */
  function buildPaddingCell(baseClassName) {
    const cell = document.createElement('div');
    cell.className = baseClassName + ' ' + baseClassName + '--empty';
    return cell;
  }

  /**
   * Adds a non-clickable "Closed" or "Opens {time}" caption to the top
   * of a day cell - called BEFORE that day's event bars are built, so it
   * lands first in the cell's stacked flex column.
   *
   * There's no proportional shaded band anymore. That geometry made
   * sense when a day column's width was the time axis and event bars
   * were positioned/scaled by time of day; once bars switched to full-
   * width stacking (grouped by start time instead), a horizontal band's
   * width stopped corresponding to anything visible on the chart and
   * became more confusing than informative. A plain-text caption says
   * the same thing precisely, in the same place a person's eye already
   * goes to find events for that row/day.
   *
   * Always shows the day's actual opening time whenever one is known,
   * regardless of how it compares to the configured display window
   * ("Day starts at" on the settings form) - it used to be suppressed
   * whenever the location was already open at the window's start, on
   * the theory that there was "nothing to flag," but the user asked to
   * see the real hours unconditionally instead of having them hidden
   * based on that comparison.
   *
   * Wording switches between future and past tense ("Opens 9:00 AM"
   * before it happens, "Opened 9:00 AM" once it has) based on `day` and
   * the current time - see hasTimePassed(). A future day always reads
   * as "Opens" (hasn't happened yet); a past day always reads as
   * "Opened" (the whole day is over); today switches the moment the
   * opening time itself passes.
   *
   * Prefers the feed's own rendered label when the times themselves
   * aren't cleanly parseable (e.g. "Open 24 Hours," "By Appointment") so
   * that information still surfaces instead of being silently dropped.
   */
  function appendOpeningCaption(dayCell, hoursEntry, day) {
    if (!hoursEntry) {
      return;
    }

    if (hoursEntry.closed) {
      const closed = document.createElement('div');
      closed.className = 'libcal-gantt__hours-caption libcal-gantt__hours-caption--closed';
      closed.textContent = hoursEntry.label || Drupal.t('Closed');
      dayCell.appendChild(closed);
      return;
    }

    if (typeof hoursEntry.openHour === 'number') {
      const opens = document.createElement('div');
      opens.className = 'libcal-gantt__hours-caption';
      const time = formatHourFraction(hoursEntry.openHour);
      opens.textContent = hasTimePassed(day, hoursEntry.openHour)
        ? Drupal.t('Opened at @time', { '@time': time })
        : Drupal.t('Opens at @time', { '@time': time });
      dayCell.appendChild(opens);
      return;
    }

    if (hoursEntry.label) {
      const note = document.createElement('div');
      note.className = 'libcal-gantt__hours-caption';
      note.textContent = hoursEntry.label;
      dayCell.appendChild(note);
    }
  }

  /**
   * Adds a "Closes {time}" caption to the bottom of a day cell - called
   * AFTER that day's event bars are built (see buildGrid()), so it lands
   * last in the stacked flex column rather than above the events. Does
   * nothing on a fully closed day (appendOpeningCaption() already said
   * so) or when no closing time is known. Otherwise always shows the
   * day's actual closing time, regardless of the configured display
   * window ("Day ends at" on the settings form) - see
   * appendOpeningCaption() for why the earlier window-relative
   * suppression was removed, and for the future/past tense switch this
   * shares with it ("Closes 5:00 PM" before it happens, "Closed 5:00
   * PM" once it has).
   */
  function appendClosingCaption(dayCell, hoursEntry, day) {
    if (!hoursEntry || hoursEntry.closed || typeof hoursEntry.closeHour !== 'number') {
      return;
    }

    const closes = document.createElement('div');
    closes.className = 'libcal-gantt__hours-caption';
    const time = formatHourFraction(hoursEntry.closeHour);
    closes.textContent = hasTimePassed(day, hoursEntry.closeHour)
      ? Drupal.t('Closed at @time', { '@time': time })
      : Drupal.t('Closes at @time', { '@time': time });
    dayCell.appendChild(closes);
  }

  /**
   * Builds the narrow-screen view: a vertical, day-by-day agenda list.
   * Small touch screens can't usefully show 10 side-by-side day columns,
   * so below the CSS breakpoint this replaces the grid entirely rather
   * than just letting it scroll horizontally.
   */
  function buildAgenda(days, events, hoursByRow, rowLabels) {
    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-agenda';

    const eventsByDay = new Map();
    days.forEach((day) => eventsByDay.set(day, []));
    events.forEach((event) => {
      Object.keys(event.segments || {}).forEach((day) => {
        if (eventsByDay.has(day)) {
          eventsByDay.get(day).push({ event, segment: event.segments[day] });
        }
      });
    });

    const today = todayDateKey();

    days.forEach((day) => {
      const section = document.createElement('section');
      section.className = 'libcal-gantt-agenda__day';
      if (dayStatus(day) === 'past') {
        section.classList.add('past_date');
      }

      const title = document.createElement('div');
      title.className = 'libcal-gantt-agenda__day-title';
      title.setAttribute('role', 'heading');
      title.setAttribute('aria-level', '3');
      title.textContent = formatDayLabel(day, true);
      section.appendChild(title);

      // One line per configured row that actually has hours data for
      // this day (a row with no Hours feed configured, or a day the
      // feed didn't cover, simply contributes no line) - hours are per
      // row now, so a single "Building hours: X" line can't represent
      // every location at once the way it could when there was only
      // ever one shared feed for the whole chart.
      (rowLabels || []).forEach((rowLabel) => {
        const summary = hoursSummary(hoursByRow && hoursByRow[rowLabel] && hoursByRow[rowLabel][day]);
        if (summary) {
          const hoursLine = document.createElement('div');
          hoursLine.className = 'libcal-gantt-agenda__hours';
          // Only meaningful for today's line specifically - see
          // computeRowOpenStatus().
          if (day === today) {
            const status = computeRowOpenStatus(rowLabel, hoursByRow);
            if (status === 'open') {
              hoursLine.classList.add('now_open');
            }
            else if (status === 'closed') {
              hoursLine.classList.add('now_closed');
            }
          }
          hoursLine.textContent = Drupal.t('@row: @hours', { '@row': rowLabel, '@hours': summary });
          section.appendChild(hoursLine);
        }
      });

      const entries = (eventsByDay.get(day) || []).sort((a, b) => a.segment.startHour - b.segment.startHour);

      if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'libcal-gantt-agenda__empty';
        empty.textContent = Drupal.t('No events scheduled.');
        section.appendChild(empty);
      } else {
        const list = document.createElement('ul');
        list.className = 'libcal-gantt-agenda__list';

        entries.forEach(({ event }) => {
          list.appendChild(buildAgendaItem(event));
        });

        section.appendChild(list);
      }

      wrap.appendChild(section);
    });

    return wrap;
  }

  function buildAgendaItem(event) {
    const item = document.createElement('li');
    item.className = 'libcal-gantt-agenda__event';

    const link = document.createElement(event.url ? 'a' : 'div');
    link.className = 'libcal-gantt-agenda__link';
    if (event.url) {
      link.href = event.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }

    const time = document.createElement('span');
    time.className = 'libcal-gantt-agenda__time';
    time.textContent = event.startLabel + '–' + event.endLabel;
    link.appendChild(time);

    const details = document.createElement('span');
    details.className = 'libcal-gantt-agenda__details';

    const titleEl = document.createElement('span');
    titleEl.className = 'libcal-gantt-agenda__title';
    titleEl.textContent = event.title;
    details.appendChild(titleEl);

    // Falls back to the event's row (e.g. "Main Library" or whatever the
    // online row is labeled) when there's no specific room/location text
    // - most often true for online events, whose location field is
    // typically blank since a physical room doesn't apply to them.
    const locationText = event.location || event.row || '';
    if (locationText) {
      const location = document.createElement('span');
      location.className = 'libcal-gantt-agenda__location';
      location.textContent = locationText;
      details.appendChild(location);
    }

    link.appendChild(details);
    item.appendChild(link);

    return item;
  }

  /**
   * Builds the "Show more weekdays" control appended after both views.
   * Re-uses the same button/state across re-renders by looking it up in
   * the freshly-rendered DOM rather than keeping a separate reference.
   */
  function buildMoreButton(container, endpoint, state) {
    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-chart__more';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'libcal-gantt-chart__more-button';
    const increment = state.pageSize || 10;
    button.textContent = Drupal.t('Show @count more weekdays', { '@count': increment });
    button.addEventListener('click', () => {
      loadPage(container, endpoint, state, false);
    });

    wrap.appendChild(button);
    return wrap;
  }

  function setMoreButtonState(container, options) {
    const wrap = container.querySelector('.libcal-gantt-chart__more');
    const button = container.querySelector('.libcal-gantt-chart__more-button');
    if (!wrap || !button) {
      return;
    }

    const existingNote = wrap.querySelector('.libcal-gantt-chart__more-error');
    if (existingNote) {
      existingNote.remove();
    }

    if (options.loading) {
      button.disabled = true;
      button.textContent = Drupal.t('Loading…');
      return;
    }

    button.disabled = false;
    if (options.error) {
      button.textContent = Drupal.t('Try again');
      const note = document.createElement('p');
      note.className = 'libcal-gantt-chart__more-error';
      note.textContent = Drupal.t('Could not load more events. Please try again.');
      wrap.appendChild(note);
    }
  }

  /**
   * Builds the chart's row roster from server config (see `row` in
   * GanttEventsController::prepareEvent() and the "Location rows"
   * setting) rather than discovering rows from whatever locations show
   * up in the data. Every configured row is always included, in the
   * server's configured order, even with zero events in the current
   * window - it's a fixed list of known locations (plus the online-
   * events row), not "whichever locations happened to have something."
   * Events that didn't match any configured row were already excluded
   * server-side, so there's no catch-all bucket to build here.
   */
  function buildRows(rowLabels, events) {
    return rowLabels.map((label) => ({
      label,
      events: events.filter((event) => event.row === label),
    }));
  }

  /**
   * Builds one full-width event bar. Bars stack in normal document flow
   * (see the day-cell's flex column layout in the CSS) rather than being
   * positioned/scaled by time of day, so - unlike the old time-axis
   * version - the bar shows its own time range rather than relying on
   * its horizontal position to convey it.
   */
  function buildBar(event) {
    const bar = document.createElement(event.url ? 'a' : 'div');
    bar.className = 'libcal-gantt__bar';
    bar.title = event.title
      + ' — ' + event.startLabel + '–' + event.endLabel
      + (event.location ? ' — ' + event.location : '');

    if (event.url) {
      bar.href = event.url;
      bar.target = '_blank';
      bar.rel = 'noopener noreferrer';
    }

    const time = document.createElement('span');
    time.className = 'libcal-gantt__bar-time';
    time.textContent = event.startLabel + '–' + event.endLabel;
    bar.appendChild(time);

    const label = document.createElement('span');
    label.className = 'libcal-gantt__bar-label';
    label.textContent = event.title;
    bar.appendChild(label);

    // Now that rows group by campus rather than by exact room, the
    // specific room/location (e.g. "[Main Library] Room 109") only lives
    // here, right under the title - same idea as the mobile agenda,
    // which has always shown location this way.
    if (event.location) {
      const location = document.createElement('span');
      location.className = 'libcal-gantt__bar-location';
      location.textContent = event.location;
      bar.appendChild(location);
    }

    return bar;
  }

  function headerCell(className, text) {
    const cell = document.createElement('div');
    cell.className = className;
    cell.textContent = text;
    return cell;
  }

  function loadingMessage() {
    const message = document.createElement('p');
    message.className = 'libcal-gantt-chart__loading';
    message.textContent = Drupal.t('Loading upcoming events…');
    return message;
  }

  function errorMessage() {
    const message = document.createElement('p');
    message.className = 'libcal-gantt-chart__error';
    message.textContent = Drupal.t('Upcoming events are unavailable right now. Please check back later.');
    return message;
  }

  function emptyMessage(text) {
    const message = document.createElement('p');
    message.className = 'libcal-gantt-chart__empty';
    message.textContent = text;
    return message;
  }

  /**
   * Returns a human-readable hours summary for a day, or null if there's
   * nothing usable to show. Prefers the feed's own rendered label (it may
   * include split shifts, "24 hours," holiday notes, etc. that a
   * from/to pair can't capture) and falls back to formatting the parsed
   * open/close hours.
   */
  function hoursSummary(entry) {
    if (!entry) {
      return null;
    }
    if (entry.closed) {
      return Drupal.t('Closed');
    }
    if (entry.label) {
      return entry.label;
    }
    if (typeof entry.openHour === 'number' && typeof entry.closeHour === 'number') {
      return formatHourFraction(entry.openHour) + ' – ' + formatHourFraction(entry.closeHour);
    }
    return null;
  }

  function formatHourFraction(hour) {
    const totalMinutes = Math.round(hour * 60);
    const h24 = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    const period = h24 >= 12 ? 'PM' : 'AM';
    let h12 = h24 % 12;
    if (h12 === 0) {
      h12 = 12;
    }
    return h12 + ':' + String(minutes).padStart(2, '0') + ' ' + period;
  }

  /**
   * Today's date as a Y-m-d string in the browser's local timezone -
   * compared directly against the server's Y-m-d day keys. The server
   * computes those in the site's configured timezone (see
   * GanttEventsController), so this assumes whatever's viewing the
   * chart is in the same timezone as the library it displays - true for
   * the on-site kiosk/desk-display use case this module targets, worth
   * knowing if this chart is ever embedded somewhere viewed remotely.
   */
  function todayDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  /**
   * The current local time of day as an hour-of-day fraction (e.g. 13.5
   * for 1:30 PM) - the same unit GanttEventsController uses for
   * openHour/closeHour, so the two can be compared directly.
   */
  function nowHourFraction() {
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60;
  }

  /**
   * Whether `day` (a Y-m-d string) is before, the same as, or after
   * today: 'past', 'today', or 'future'. A plain string compare is
   * enough because Y-m-d sorts lexicographically the same way it sorts
   * chronologically.
   */
  function dayStatus(day) {
    const today = todayDateKey();
    if (day < today) {
      return 'past';
    }
    if (day > today) {
      return 'future';
    }
    return 'today';
  }

  /**
   * Whether a specific hour-of-day on `day` has already happened, as of
   * right now - drives the Opens/Opened and Closes/Closed tense switch
   * in appendOpeningCaption()/appendClosingCaption(). A future day
   * hasn't happened at all yet (always false); a past day is entirely
   * over so every hour in it counts as passed (always true); today
   * compares the specific hour against the current time.
   */
  function hasTimePassed(day, hour) {
    const status = dayStatus(day);
    if (status === 'future') {
      return false;
    }
    if (status === 'past') {
      return true;
    }
    return nowHourFraction() >= hour;
  }

  /**
   * Whether a row's location is open right now, based on its hours
   * entry for TODAY specifically - a row's current open/closed status
   * obviously isn't meaningful relative to any other day. Returns
   * 'open', 'closed', or null when there's no way to tell (no hours
   * data for this row at all, or none for today specifically - e.g. the
   * feed didn't cover it, or today isn't one of the days loaded into
   * state yet).
   */
  function computeRowOpenStatus(rowLabel, hoursByRow) {
    const rowHours = hoursByRow && hoursByRow[rowLabel];
    const entry = rowHours && rowHours[todayDateKey()];
    if (!entry) {
      return null;
    }
    if (entry.closed) {
      return 'closed';
    }
    const now = nowHourFraction();
    if (typeof entry.openHour === 'number' && typeof entry.closeHour === 'number') {
      return (now >= entry.openHour && now < entry.closeHour) ? 'open' : 'closed';
    }
    if (typeof entry.openHour === 'number') {
      return now >= entry.openHour ? 'open' : 'closed';
    }
    return null;
  }

  function formatDayLabel(day, long) {
    const date = new Date(day + 'T00:00:00');
    if (Number.isNaN(date.getTime())) {
      return day;
    }
    const options = long
      ? { weekday: 'long', month: 'short', day: 'numeric' }
      : { weekday: 'short', month: 'short', day: 'numeric' };
    try {
      return date.toLocaleDateString(undefined, options);
    } catch (e) {
      return day;
    }
  }

})(Drupal, drupalSettings, once);