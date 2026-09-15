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
   * Mobile agenda pagination is event-count-driven rather than day-count-
   * driven (unlike the desktop grid, which always pages by
   * GRID_DAYS_PER_ROW/weekday count) - a day range that's reasonable on
   * the wide grid can still mean a very long scroll on a phone once
   * several busy days are stacked vertically, so the agenda instead shows
   * "enough days to cover N events" and grows by event count on each
   * "Show more" click. See buildAgenda()/computeAgendaCutoff()/
   * loadMoreMobileEvents(). Both counts are in event *occurrences*
   * (one per day an event has a segment on - a 3-day merged display
   * counts 3 times here, matching how many list items it actually
   * contributes to the agenda), not unique events, and both respect the
   * active building filter (see buildAgendaRowFilter()) since that
   * changes how many days it takes to reach the target.
   */
  const MOBILE_INITIAL_EVENT_COUNT = 12;
  const MOBILE_EVENTS_PER_CLICK = 8;

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
      // Which row label the mobile agenda is narrowed to (see
      // buildAgendaRowFilter()), or null for "All buildings" (the
      // default). Deliberately NOT reset by switchCalendar()/loadPage() -
      // unlike the day range, a visitor's chosen building filter is a
      // display preference that should survive paging/tab-switching, not
      // page-specific state.
      agendaRowFilter: null,
      // How many of state.days (from the start) the mobile agenda
      // currently reveals - null means "not computed yet for the current
      // data/filter," recomputed on demand in buildAgenda() via
      // computeAgendaCutoff(). Reset to null (not 0) whenever the
      // underlying data set changes shape in a way that should re-run
      // that calculation from scratch: a full reset (switchCalendar()) or
      // a building-filter change (buildAgendaRowFilter()) - NOT after a
      // normal "Show more events" click, which sets this directly to
      // whatever loadMoreMobileEvents() computed instead of clearing it.
      agendaVisibleDayCount: null,
      // Friday->Monday weekend markers (see GanttEventsController::
      // buildWeekendMarkers()) and each row's weekend hours/events - see
      // the weekend accessory column (buildGrid()) and the mobile weekend
      // divider (buildAgenda()).
      weekends: [],
      weekendHours: {},
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

  /**
   * Fetches the next page of weekdays and merges it into `state`.
   *
   * `onLoaded`, when given, runs right after mergeData() but before the
   * resulting renderChart() - used by loadMoreMobileEvents() to extend
   * how many days the mobile agenda reveals into the just-arrived data
   * before it's drawn, so the new events show up already-revealed rather
   * than requiring a second click. `variant` ('desktop' or 'mobile')
   * picks which of the two "show more" buttons (see buildMoreButton()/
   * buildMobileMoreButton()) reflects this request's loading/error state -
   * irrelevant (and unused) for a first load, which replaces the whole
   * container with a loading message instead.
   */
  function loadPage(container, endpoint, state, isFirstLoad, onLoaded, variant) {
    if (state.loading) {
      return;
    }
    state.loading = true;

    if (isFirstLoad) {
      container.innerHTML = '';
      container.appendChild(loadingMessage());
    }
    else {
      setMoreButtonState(container, { loading: true, variant: variant });
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
        if (typeof onLoaded === 'function') {
          onLoaded();
        }
        renderChart(container, endpoint, state);
      })
      .catch((error) => {
        state.loading = false;
        if (isFirstLoad) {
          container.innerHTML = '';
          container.appendChild(errorMessage());
        }
        else {
          setMoreButtonState(container, { loading: false, error: true, variant: variant });
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
    state.weekends = [];
    state.weekendHours = {};
    state.agendaVisibleDayCount = null;
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

    // Weekend markers/hours, same idea: a marker is uniquely identified
    // by its `after` (Friday) date, so later pages just add whichever
    // markers weren't already known - two pages should never actually
    // describe the same weekend, but de-duping defensively costs
    // nothing. weekendHours merges exactly like `hours` above.
    if (Array.isArray(data.weekends)) {
      const existingAfters = new Set(state.weekends.map((weekend) => weekend.after));
      data.weekends.forEach((weekend) => {
        if (!existingAfters.has(weekend.after)) {
          state.weekends.push(weekend);
        }
      });
    }
    if (data.weekendHours && typeof data.weekendHours === 'object') {
      Object.keys(data.weekendHours).forEach((rowLabel) => {
        if (!state.weekendHours[rowLabel]) {
          state.weekendHours[rowLabel] = {};
        }
        Object.assign(state.weekendHours[rowLabel], data.weekendHours[rowLabel]);
      });
    }
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
    const scale = {
      dayStartHour: state.dayStartHour,
      dayEndHour: state.dayEndHour,
      hours: state.hours,
      weekends: state.weekends,
      weekendHours: state.weekendHours,
    };

    // Whether the active calendar tab's events are tied to building hours
    // at all - see LibCalClient::parseCalendars()'s "|no-hours" flag. A
    // calendar like "Library Displays" is always visible to passersby
    // regardless of when the building itself opens/closes, so the
    // Opens/Closes captions and open/closed indicator would just describe
    // something unrelated to what that tab shows; defaults to true (shown)
    // when the active calendar isn't found or the server predates this
    // field, matching the single-calendar/no-tabs case.
    const activeCalendar = (state.calendars || []).find((calendar) => calendar.id === state.calendarId);
    const calendarShowHours = !activeCalendar || activeCalendar.showHours !== false;

    // Both views are rendered up front and CSS media queries decide which
    // one is visible. That keeps the swap instant on rotation/resize with
    // no resize listener, and both stay in sync with the same data.
    container.appendChild(buildGrid(state.days, rows, scale, calendarShowHours));
    container.appendChild(buildAgenda(container, endpoint, state, calendarShowHours));
    // Two separate "show more" controls, like the grid/agenda split above -
    // both always in the DOM, CSS decides which is visible. The desktop
    // one pages by weekday count (unchanged); the mobile one pages by
    // event count instead, since a day range that's fine on the wide grid
    // can still be a very long phone scroll - see buildMobileMoreButton().
    container.appendChild(buildMoreButton(container, endpoint, state));
    container.appendChild(buildMobileMoreButton(container, endpoint, state));
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
   * location, at most GRID_DAYS_PER_ROW day columns wide. Building hours
   * (when configured, and when `calendarShowHours` is true - see the
   * active calendar's "|no-hours" flag in LibCalClient::parseCalendars())
   * show as small "Opens"/"Closes"/"Closed" captions bracketing that
   * row's events for the day - see appendOpeningCaption()/
   * appendClosingCaption(). Hours are per ROW (each location row can have
   * its own Hours feed - see "Location rows" in the settings form), not
   * shared across the whole chart, so the day-header row itself never
   * shows an hours line - it can't represent more than one row's hours
   * at once.
   *
   * Beyond GRID_DAYS_PER_ROW accumulated days, "Show more" grows this
   * view downward rather than sideways: the days are split into blocks
   * of GRID_DAYS_PER_ROW, and each block gets its own header row (corner
   * + day headers) and its own copy of every location's row, stacked
   * below the previous block.
   *
   * Every cell in this grid is placed with EXPLICIT `grid-row`/
   * `grid-column` inline styles (via positionCell() for the simple ones)
   * rather than relying on CSS Grid's implicit auto-placement from DOM
   * order. That's what makes two things possible that auto-placement
   * couldn't do: (1) a location row can occupy a variable number of
   * sub-rows within the same grid depending on how many merged multi-day
   * event runs it has in a given block (see below), and (2) a merged
   * run's bar can span multiple day columns as a single grid item.
   *
   * Merged multi-day events: when the same event (matched by row + title
   * + location + start/end time) repeats on CONSECUTIVE loaded weekdays -
   * the common pattern for a LibCal "Displays" calendar, where a display
   * case's contents are entered as one separate event per day rather
   * than one event spanning a date range - computeMergedRunsForRow()
   * folds that run into a single spanning bar instead of duplicating it
   * in every day's cell. Each row therefore gets one extra grid sub-row
   * per merged run active in a given block (rendered by buildSpanningBar()
   * above the row's normal day-cells sub-row, which still handles any
   * day-specific events that AREN'T part of a merged run, plus the hours
   * captions), with the row header spanning all of that row's sub-rows
   * via `grid-row: line / span N`.
   *
   * Weekend accessory column: each block also gets a narrow extra column
   * for every weekend gap it contains (see GanttEventsController::
   * buildWeekendMarkers() / `scale.weekends`), inserted immediately after
   * whichever real day column it follows - see planBlockColumns(). Each
   * block is now its OWN independent CSS Grid (`.libcal-gantt-block`,
   * built by buildGridBlock()) with its own `grid-template-columns`,
   * rather than every block sharing one grid with a single fixed column
   * count - necessary because the weekend gap can fall at a different
   * position within different blocks (which real weekday a block starts
   * on isn't fixed), so one block's narrow weekend track and another
   * block's normal-width day track can land at the same column-line
   * number, which a single shared column template can't give two
   * different widths at once. `.libcal-gantt` itself is now just a
   * flex-column wrapper stacking each block.
   */
  function buildGrid(days, rows, scale, calendarShowHours) {
    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt';
    wrap.setAttribute('role', 'table');
    wrap.setAttribute('aria-label', Drupal.t('Upcoming events'));

    if (!rows.length) {
      // Nothing row-based to repeat below, so just one header plus one
      // message, regardless of how many days are loaded - no weekend
      // column either, since there's no row to show one for.
      const plan = planBlockColumns(days.slice(0, GRID_DAYS_PER_ROW), new Map());
      const block = document.createElement('div');
      block.className = 'libcal-gantt-block';
      block.style.gridTemplateColumns = blockColumnTemplate(plan);
      block.appendChild(positionCell(headerCell('libcal-gantt__corner', ''), 1, 1));
      plan.forEach((track) => {
        const cell = track.type === 'day' ? buildDayHeaderCell(track.day) : buildPaddingCell('libcal-gantt__day-header');
        block.appendChild(positionCell(cell, 1, track.col));
      });
      const empty = document.createElement('div');
      empty.className = 'libcal-gantt__empty-row';
      empty.style.gridRow = '2';
      empty.style.gridColumn = '1 / -1';
      empty.textContent = Drupal.t('No events scheduled in this window.');
      block.appendChild(empty);
      wrap.appendChild(block);
      return wrap;
    }

    const chunks = [];
    for (let i = 0; i < days.length; i += GRID_DAYS_PER_ROW) {
      chunks.push({ startIndex: i, days: days.slice(i, i + GRID_DAYS_PER_ROW) });
    }

    // A row's "open right now" status is about the current moment, not
    // about which block of days happens to be on screen, so it's the
    // same for every repeated copy of that row's header - computed once
    // here rather than per block. Skipped entirely for a calendar whose
    // events aren't tied to building hours (see calendarShowHours doc
    // above) - there's nothing meaningful to indicate.
    const rowStatus = {};
    rows.forEach((row) => {
      rowStatus[row.label] = calendarShowHours ? computeRowOpenStatus(row.label, scale.hours) : null;
    });

    // Merged runs are computed once per row across the FULL loaded day
    // range (not per block) - see computeMergedRunsForRow() - then
    // clipped to whichever block(s) they actually fall in below, so a
    // run that straddles a block boundary still renders correctly as two
    // separate spanning bars, one per block, rather than being dropped
    // or misplaced.
    const rowMerges = {};
    rows.forEach((row) => {
      rowMerges[row.label] = computeMergedRunsForRow(days, row.events);
    });

    const weekendByAfter = new Map();
    (scale.weekends || []).forEach((weekend) => {
      weekendByAfter.set(weekend.after, weekend);
    });

    chunks.forEach((chunk) => {
      wrap.appendChild(buildGridBlock(chunk, rows, scale, calendarShowHours, rowStatus, rowMerges, weekendByAfter));
    });

    return wrap;
  }

  /**
   * Builds one "page" of up to GRID_DAYS_PER_ROW real day columns (plus
   * any weekend accessory column(s) that fall within them) as its own
   * independent CSS Grid - see buildGrid()'s doc for why each block needs
   * its own `grid-template-columns` rather than sharing one across every
   * block.
   */
  function buildGridBlock(chunk, rows, scale, calendarShowHours, rowStatus, rowMerges, weekendByAfter) {
    const chunkDays = chunk.days;
    const plan = planBlockColumns(chunkDays, weekendByAfter);
    const dayColumns = new Map();
    plan.forEach((track) => {
      if (track.type === 'day') {
        dayColumns.set(track.day, track.col);
      }
    });

    const block = document.createElement('div');
    block.className = 'libcal-gantt-block';
    block.style.gridTemplateColumns = blockColumnTemplate(plan);
    block.setAttribute('role', 'rowgroup');

    block.appendChild(positionCell(headerCell('libcal-gantt__corner', ''), 1, 1));
    plan.forEach((track) => {
      let cell;
      if (track.type === 'day') {
        cell = buildDayHeaderCell(track.day);
      }
      else if (track.type === 'weekend') {
        cell = buildWeekendHeaderCell();
      }
      else {
        cell = buildPaddingCell('libcal-gantt__day-header');
      }
      block.appendChild(positionCell(cell, 1, track.col));
    });

    let gridLine = 2;

    rows.forEach((row) => {
      const { runs, consumedByEvent } = rowMerges[row.label];
      const spans = clipRunsToChunk(runs, chunk.startIndex, chunkDays, dayColumns);
      const subRowCount = spans.length + 1;

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
      rowHeader.style.gridColumn = '1';
      rowHeader.style.gridRow = gridLine + ' / span ' + subRowCount;
      block.appendChild(rowHeader);

      // One dedicated sub-row per merged run active in this block, each
      // a single grid item spanning the columns it covers (including
      // straight through any weekend column in between, when a run
      // continues across a weekend it's merged with) - see
      // buildSpanningBar().
      spans.forEach((span, idx) => {
        const bar = buildSpanningBar(span.run);
        bar.style.gridRow = String(gridLine + idx);
        bar.style.gridColumn = span.startGridCol + ' / span ' + span.gridColSpan;
        block.appendChild(bar);
      });

      // The row's normal per-day-cell sub-row: hours captions and any
      // day-specific event that isn't part of a merged run, plus - at
      // whatever column planBlockColumns() gave it - this row's weekend
      // cell for any gap in this block.
      const dayCellsLine = gridLine + spans.length;
      const rowHours = scale.hours[row.label] || {};
      const weekendHoursForRow = (scale.weekendHours && scale.weekendHours[row.label]) || {};

      plan.forEach((track) => {
        if (track.type === 'pad') {
          block.appendChild(positionCell(buildPaddingCell('libcal-gantt__day-cell'), dayCellsLine, track.col));
          return;
        }

        if (track.type === 'weekend') {
          const cell = buildWeekendCell(row, track.weekend, weekendHoursForRow, calendarShowHours);
          cell.style.gridRow = String(dayCellsLine);
          cell.style.gridColumn = String(track.col);
          block.appendChild(cell);
          return;
        }

        const day = track.day;
        const dayCell = document.createElement('div');
        dayCell.className = 'libcal-gantt__day-cell';
        dayCell.dataset.date = day;
        if (dayStatus(day) === 'past') {
          dayCell.classList.add('past_date');
        }
        dayCell.style.gridRow = String(dayCellsLine);
        dayCell.style.gridColumn = String(track.col);

        const dayHours = rowHours[day];

        // Opening caption (or "Closed") goes in first, so it lands at
        // the top of the cell's stacked flex column, ahead of any real
        // events - see the function doc for why this replaced the old
        // proportional shading.
        if (calendarShowHours) {
          appendOpeningCaption(dayCell, dayHours, day);
        }

        // Events that are part of a merged run already got their own
        // spanning bar above - excluded here by (event, day) so they
        // don't ALSO render duplicated inside this day's cell.
        const dayEvents = row.events
          .filter((event) => event.segments && event.segments[day])
          .filter((event) => {
            const consumedDays = consumedByEvent.get(event);
            return !consumedDays || !consumedDays.has(day);
          })
          .sort((a, b) => a.segments[day].startHour - b.segments[day].startHour);

        dayEvents.forEach((event) => {
          dayCell.appendChild(buildBar(event));
        });

        // Closing caption is appended last, deliberately after the
        // events loop above, so it lands at the bottom of the stack.
        if (calendarShowHours) {
          appendClosingCaption(dayCell, dayHours, day);
        }

        block.appendChild(dayCell);
      });

      gridLine += subRowCount;
    });

    return block;
  }

  /**
   * Plans one block's column layout: a `{type, col, ...}` entry per
   * column-track, in left-to-right order, where `type` is `'day'`
   * (carries `day`), `'weekend'` (carries `weekend`, the marker from
   * GanttEventsController::buildWeekendMarkers() whose `after` equals
   * the real day just before it), or `'pad'` (a short final block's
   * unfilled day columns - see buildPaddingCell()). `col` is the
   * absolute grid-column line number (column 1 is always the row-label
   * column, reserved by the caller). A weekend track is inserted
   * immediately after the real day it follows, so its position varies
   * block to block depending on which weekday that block happens to
   * start on - see buildGrid()'s doc for why that means each block needs
   * its own grid-template-columns rather than sharing one.
   */
  function planBlockColumns(chunkDays, weekendByAfter) {
    const plan = [];
    let col = 2;

    chunkDays.forEach((day) => {
      if (day) {
        plan.push({ type: 'day', day: day, col: col });
        col++;
        const weekend = weekendByAfter.get(day);
        if (weekend) {
          plan.push({ type: 'weekend', weekend: weekend, col: col });
          col++;
        }
      }
      else {
        plan.push({ type: 'pad', col: col });
        col++;
      }
    });

    return plan;
  }

  /**
   * Renders a planBlockColumns() plan into a `grid-template-columns`
   * value: a normal `minmax(90px, 1fr)` track per day/pad column, and a
   * narrower `--libcal-gantt-weekend-width` track per weekend column.
   */
  function blockColumnTemplate(plan) {
    const tracks = plan.map((track) => (
      track.type === 'weekend' ? 'var(--libcal-gantt-weekend-width, 88px)' : 'minmax(90px, 1fr)'
    ));
    return 'var(--libcal-gantt-row-label-width) ' + tracks.join(' ');
  }

  /**
   * Sets a grid item's explicit line placement and returns it, for the
   * common case of a single-row, single-column cell (header/padding
   * cells) - see buildGrid()'s doc for why placement is explicit rather
   * than relying on auto-flow.
   */
  function positionCell(cell, row, col) {
    cell.style.gridRow = String(row);
    cell.style.gridColumn = String(col);
    return cell;
  }

  /**
   * The header cell for a block's weekend accessory column - see
   * planBlockColumns(). Deliberately just a plain label; the interesting
   * per-row content (hours or a scheduled event) lives in
   * buildWeekendCell() below, one per row.
   */
  function buildWeekendHeaderCell() {
    const cell = document.createElement('div');
    cell.className = 'libcal-gantt__weekend-header';
    cell.textContent = Drupal.t('Weekend');
    return cell;
  }

  /**
   * Builds one row's cell in a block's weekend accessory column. Gets
   * class `event_weekend` (and lists the scheduled event(s)) when this
   * row has at least one event on that weekend's Saturday or Sunday (per
   * GanttEventsController's `weekends[].events`, keyed by row label) -
   * otherwise class `empty_weekend`, showing that row's Saturday/Sunday
   * hours instead (skipped when `calendarShowHours` is false, same as
   * the regular day-cell captions, since there's nothing meaningful to
   * show there for a calendar not tied to building hours).
   */
  function buildWeekendCell(row, weekend, weekendHoursForRow, calendarShowHours) {
    const cell = document.createElement('div');
    cell.className = 'libcal-gantt__weekend-cell';

    const events = (weekend.events && weekend.events[row.label]) || [];

    if (events.length) {
      cell.classList.add('event_weekend');
      events.forEach((event) => {
        cell.appendChild(buildWeekendEventNote(event));
      });
      return cell;
    }

    cell.classList.add('empty_weekend');
    if (!calendarShowHours) {
      return cell;
    }

    const satSummary = hoursSummary(weekendHoursForRow[weekend.saturday]);
    const sunSummary = hoursSummary(weekendHoursForRow[weekend.sunday]);
    if (satSummary) {
      cell.appendChild(buildWeekendHoursLine(Drupal.t('Sat'), satSummary));
    }
    if (sunSummary) {
      cell.appendChild(buildWeekendHoursLine(Drupal.t('Sun'), sunSummary));
    }

    return cell;
  }

  function buildWeekendHoursLine(dayAbbrev, summary) {
    const line = document.createElement('div');
    line.className = 'libcal-gantt__weekend-hours';
    line.textContent = dayAbbrev + ' ' + summary;
    return line;
  }

  function buildWeekendEventNote(event) {
    const note = document.createElement(event.url ? 'a' : 'div');
    note.className = 'libcal-gantt__weekend-event';
    if (event.url) {
      note.href = event.url;
      note.target = '_blank';
      note.rel = 'noopener noreferrer';
    }
    note.title = event.title + ' — ' + event.startLabel + '–' + event.endLabel + (event.location ? ' — ' + event.location : '');

    const dayAbbrev = formatDayLabel(event.day, false).split(',')[0];

    const time = document.createElement('span');
    time.className = 'libcal-gantt__weekend-event-time';
    time.textContent = dayAbbrev + ' ' + event.startLabel + '–' + event.endLabel;
    note.appendChild(time);

    const title = document.createElement('span');
    title.className = 'libcal-gantt__weekend-event-title';
    title.textContent = event.title;
    note.appendChild(title);

    return note;
  }

  /**
   * The identity used to decide whether two events are "the same
   * recurring thing" for merging purposes - same location row, same
   * title, same location text, and the same start/end time of day. Two
   * events that only share a title (e.g. genuinely different sessions of
   * an ongoing workshop at different times) are deliberately NOT merged.
   */
  function mergeKey(event) {
    return [event.row, event.title, event.location || '', event.startLabel, event.endLabel].join('\u0000');
  }

  /**
   * Finds runs of the "same" event (per mergeKey()) occurring on
   * consecutive entries of the loaded `days` list - not consecutive
   * calendar dates, deliberately: `days` already skips weekends, so a
   * Friday immediately followed (in `days`) by the next Monday is
   * treated as one unbroken run, which is exactly right for something
   * like an always-visible display case that doesn't stop over the
   * weekend even though this module never fetches Saturday/Sunday event
   * data at all.
   *
   * Only runs of 2 or more days are merged - a event that only ever
   * appears once is left as an ordinary individual event, rendered in
   * its own day cell as before, so a calendar with no repeats (a typical
   * "Events" calendar) renders identically to before this feature
   * existed.
   *
   * @return {{ runs: Array<{key: string, title: string, location: string,
   *   image: string, startLabel: string, endLabel: string, url: string,
   *   days: string[], dayIndices: number[]}>, consumedByEvent: Map<object,
   *   Set<string>> }}
   *   `runs` is every merged run found for this row (order not
   *   significant - clipRunsToChunk() re-derives per-block position from
   *   dayIndices). `consumedByEvent` maps each original event object to
   *   the set of its own day keys that got folded into a run, so
   *   buildGrid() can exclude exactly those (event, day) pairs from the
   *   normal per-day-cell rendering without needing event ids.
   */
  function computeMergedRunsForRow(days, rowEvents) {
    const dayIndex = new Map();
    days.forEach((day, i) => dayIndex.set(day, i));

    // key -> Map(day -> event)
    const groups = new Map();
    rowEvents.forEach((event) => {
      const key = mergeKey(event);
      Object.keys(event.segments || {}).forEach((day) => {
        if (!dayIndex.has(day)) {
          return;
        }
        if (!groups.has(key)) {
          groups.set(key, new Map());
        }
        groups.get(key).set(day, event);
      });
    });

    const runs = [];
    const consumedByEvent = new Map();
    const today = todayDateKey();

    groups.forEach((dayMap) => {
      const sortedDays = Array.from(dayMap.keys()).sort((a, b) => dayIndex.get(a) - dayIndex.get(b));

      let i = 0;
      while (i < sortedDays.length) {
        let j = i;
        while (j + 1 < sortedDays.length && dayIndex.get(sortedDays[j + 1]) === dayIndex.get(sortedDays[j]) + 1) {
          j++;
        }

        const runDays = sortedDays.slice(i, j + 1);
        if (runDays.length >= 2) {
          const firstEvent = dayMap.get(runDays[0]);
          // "The link to the event that matches the current day" - falls
          // back to the run's first day when today isn't part of this
          // particular run (e.g. viewing a future "Show more" page).
          const chosenEvent = (runDays.indexOf(today) !== -1 ? dayMap.get(today) : null) || firstEvent;

          runs.push({
            key: mergeKey(firstEvent),
            title: firstEvent.title,
            location: firstEvent.location,
            // A recurring display's featured image is the same on every
            // day's copy in practice (same mergeKey() match requires the
            // same title/location/time already), so the first day's is as
            // good as any - see buildBar()'s applyBarImage() for how this
            // is actually rendered.
            image: firstEvent.image,
            startLabel: firstEvent.startLabel,
            endLabel: firstEvent.endLabel,
            url: chosenEvent.url,
            days: runDays,
            dayIndices: runDays.map((day) => dayIndex.get(day)),
          });

          runDays.forEach((day) => {
            const event = dayMap.get(day);
            if (!consumedByEvent.has(event)) {
              consumedByEvent.set(event, new Set());
            }
            consumedByEvent.get(event).add(day);
          });
        }

        i = j + 1;
      }
    });

    return { runs, consumedByEvent };
  }

  /**
   * Clips a row's merged runs (computed once across the full loaded day
   * range - see computeMergedRunsForRow()) down to whichever piece of
   * each run falls within one block, returning the actual grid-column
   * line numbers (`dayColumns`, from this block's own planBlockColumns()
   * plan) buildGridBlock() needs to place that block's spanning bar. A
   * run entirely outside this block contributes nothing; a run
   * straddling the block boundary still contributes its in-block portion
   * here (the rest shows up when this same function is called for the
   * next block). When a run continues straight through a weekend gap
   * (e.g. a display merged Friday through the next Monday), the span
   * returned here correctly stretches across that weekend's accessory
   * column too, since it's computed from the first/last real day's
   * actual column line rather than a real-day count.
   */
  function clipRunsToChunk(runs, chunkStartIndex, chunkDays, dayColumns) {
    const clipped = [];
    const chunkEndIndex = chunkStartIndex + chunkDays.length;

    runs.forEach((run) => {
      const inChunk = run.dayIndices.filter((index) => index >= chunkStartIndex && index < chunkEndIndex);
      if (!inChunk.length) {
        return;
      }
      const minIndex = Math.min.apply(null, inChunk);
      const maxIndex = Math.max.apply(null, inChunk);
      const firstDay = chunkDays[minIndex - chunkStartIndex];
      const lastDay = chunkDays[maxIndex - chunkStartIndex];
      const startGridCol = dayColumns.get(firstDay);
      const endGridCol = dayColumns.get(lastDay);
      if (startGridCol === undefined || endGridCol === undefined) {
        return;
      }
      clipped.push({
        run,
        startGridCol: startGridCol,
        gridColSpan: endGridCol - startGridCol + 1,
      });
    });

    return clipped;
  }

  /**
   * Builds one merged event's spanning bar - visually the same as a
   * normal buildBar() bar (same classes, so it inherits the same
   * styling), but for a run of 2+ consecutive days rather than a single
   * day, and placed by the caller with an explicit `grid-column: start /
   * span N` instead of living inside one day cell. The native `title`
   * tooltip includes the date range since that's no longer implied by
   * which single cell the bar sits in.
   */
  function buildSpanningBar(run) {
    const bar = document.createElement(run.url ? 'a' : 'div');
    bar.className = 'libcal-gantt__bar libcal-gantt__bar--spanning';

    const dateRange = run.days.length > 1
      ? formatDayLabel(run.days[0], false) + ' – ' + formatDayLabel(run.days[run.days.length - 1], false)
      : formatDayLabel(run.days[0], false);
    bar.title = run.startLabel + '–' + run.endLabel
      + ' — ' + dateRange
      + (run.location ? ' — ' + run.location : '')
      + ' — ' + run.title;

    if (run.url) {
      bar.href = run.url;
      bar.target = '_blank';
      bar.rel = 'noopener noreferrer';
    }

    applyBarImage(bar, run.image);

    const time = document.createElement('span');
    time.className = 'libcal-gantt__bar-time';
    time.textContent = run.startLabel + '–' + run.endLabel;
    bar.appendChild(time);

    if (run.location) {
      const location = document.createElement('span');
      location.className = 'libcal-gantt__bar-location';
      location.textContent = run.location;
      bar.appendChild(location);
    }

    const label = document.createElement('span');
    label.className = 'libcal-gantt__bar-label';
    label.textContent = run.title;
    bar.appendChild(label);

    return bar;
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
   *
   * Takes `container`/`endpoint`/`state` (rather than just the plain
   * data buildGrid() takes) because the building filter row it renders
   * (see buildAgendaRowFilter()) needs to trigger a full re-render on
   * click, the same pattern buildCalendarTabs() uses for switching
   * calendars.
   */
  function buildAgenda(container, endpoint, state, calendarShowHours) {
    const events = state.events;
    const hoursByRow = state.hours;
    const weekendHoursByRow = state.weekendHours;
    const rowLabels = state.rowLabels;

    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-agenda';

    const filter = buildAgendaRowFilter(container, endpoint, state);
    if (filter) {
      wrap.appendChild(filter);
    }

    const activeRow = state.agendaRowFilter;
    const visibleRowLabels = activeRow ? [activeRow] : (rowLabels || []);

    // See MOBILE_INITIAL_EVENT_COUNT - the agenda only ever renders a
    // leading slice of state.days, sized by event count rather than by a
    // fixed day count, computed once per data/filter combination and then
    // kept (see the null-reset points documented on state.agendaVisibleDayCount).
    if (state.agendaVisibleDayCount === null) {
      state.agendaVisibleDayCount = computeAgendaCutoff(state, 0, MOBILE_INITIAL_EVENT_COUNT).cutoff;
    }
    const days = state.days.slice(0, state.agendaVisibleDayCount);

    const eventsByDay = new Map();
    days.forEach((day) => eventsByDay.set(day, []));
    events.forEach((event) => {
      if (activeRow && event.row !== activeRow) {
        return;
      }
      Object.keys(event.segments || {}).forEach((day) => {
        if (eventsByDay.has(day)) {
          eventsByDay.get(day).push({ event, segment: event.segments[day] });
        }
      });
    });

    const today = todayDateKey();
    const weekendByAfter = new Map();
    (state.weekends || []).forEach((weekend) => weekendByAfter.set(weekend.after, weekend));

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
      // ever one shared feed for the whole chart. Skipped entirely when
      // the active calendar's events aren't tied to building hours (see
      // calendarShowHours in buildGrid()'s doc) - and narrowed to just
      // the filtered row, if one is selected.
      if (calendarShowHours) {
        visibleRowLabels.forEach((rowLabel) => {
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
      }

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

      // A weekend divider goes right after whichever day's section is
      // the "after" (Friday, in every normal case) of a weekend gap -
      // see GanttEventsController::buildWeekendMarkers(). Skipped when
      // there's nothing worth showing - see buildAgendaWeekendDivider().
      const weekend = weekendByAfter.get(day);
      if (weekend) {
        const divider = buildAgendaWeekendDivider(weekend, visibleRowLabels, weekendHoursByRow, calendarShowHours);
        if (divider) {
          wrap.appendChild(divider);
        }
      }
    });

    return wrap;
  }

  /**
   * Walks state.days forward from `startIndex`, counting event
   * *occurrences* (one per day a not-yet-filtered-out event has a
   * segment on - matching how many list items that day actually
   * contributes to the agenda) until at least `targetIncrement` have been
   * seen or the loaded days run out. Respects the active building filter
   * (state.agendaRowFilter) the same way buildAgenda()'s own eventsByDay
   * construction does, since a narrower filter means more days are
   * needed to reach the same event count.
   *
   * Returns `{cutoff, count}` - `cutoff` is the new day-count boundary
   * (an index into state.days, exclusive - i.e. state.days.slice(0,
   * cutoff) is everything that should now be visible), `count` is how
   * many occurrences were actually found between `startIndex` and
   * `cutoff` (which can be less than `targetIncrement` if state.days ran
   * out first - see loadMoreMobileEvents(), which uses that shortfall to
   * decide whether more needs to be fetched from the server).
   */
  function computeAgendaCutoff(state, startIndex, targetIncrement) {
    const activeRow = state.agendaRowFilter;
    let count = 0;
    let index = startIndex;

    while (index < state.days.length && count < targetIncrement) {
      const day = state.days[index];
      state.events.forEach((event) => {
        if (activeRow && event.row !== activeRow) {
          return;
        }
        if (event.segments && event.segments[day]) {
          count++;
        }
      });
      index++;
    }

    return { cutoff: index, count: count };
  }

  /**
   * Handles a click on the mobile "Show N more events" button (see
   * buildMobileMoreButton()). First tries to satisfy MOBILE_EVENTS_PER_CLICK
   * more occurrences purely by revealing more of what's already loaded
   * (common once a "Show more weekdays" click on the desktop view, or an
   * earlier mobile click, pulled in more days than the agenda was
   * currently showing). Only reaches out to the server - via the same
   * `loadPage()` the desktop button uses, so it's the identical request/
   * cache/pagination contract, just also extending the reveal cutoff into
   * whatever comes back - when the already-loaded days can't fully cover
   * this click on their own.
   */
  function loadMoreMobileEvents(container, endpoint, state) {
    if (state.loading) {
      return;
    }

    const startIndex = state.agendaVisibleDayCount || 0;
    const result = computeAgendaCutoff(state, startIndex, MOBILE_EVENTS_PER_CLICK);
    state.agendaVisibleDayCount = result.cutoff;

    if (result.count < MOBILE_EVENTS_PER_CLICK && result.cutoff >= state.days.length) {
      const remaining = MOBILE_EVENTS_PER_CLICK - result.count;
      loadPage(container, endpoint, state, false, () => {
        const more = computeAgendaCutoff(state, state.agendaVisibleDayCount, remaining);
        state.agendaVisibleDayCount = more.cutoff;
      }, 'mobile');
      return;
    }

    renderChart(container, endpoint, state);
  }

  /**
   * The mobile agenda's own "Show more" control - counts events instead
   * of weekdays (see MOBILE_INITIAL_EVENT_COUNT/MOBILE_EVENTS_PER_CLICK
   * above), so it's a separate button from the desktop grid's
   * buildMoreButton() rather than a shared one. Both are always rendered
   * (see renderChart()); which one is visible is a plain CSS media query,
   * same mechanism already used to swap the grid and agenda views
   * themselves.
   */
  function buildMobileMoreButton(container, endpoint, state) {
    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-chart__more libcal-gantt-chart__more--mobile';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'libcal-gantt-chart__more-button';
    button.textContent = Drupal.t('Show @count more events', { '@count': MOBILE_EVENTS_PER_CLICK });
    button.addEventListener('click', () => {
      loadMoreMobileEvents(container, endpoint, state);
    });

    wrap.appendChild(button);
    return wrap;
  }

  /**
   * Builds the mobile agenda's weekend divider for one Friday->Monday gap
   * - a single section between the two, since (unlike the desktop grid's
   * per-row weekend accessory column) the agenda already lists every
   * visible row in one place rather than as separate side-by-side
   * columns.
   *
   * Class `event_weekend` (and a list of the scheduled event(s), reusing
   * the same time/title/location layout as a normal agenda item) when
   * ANY visible row has something scheduled that weekend; otherwise class
   * `empty_weekend`, showing each visible row's Saturday/Sunday hours -
   * "both buildings' hours," per the user's request, when nothing is
   * scheduled. Hours are skipped (not just the divider itself) when
   * `calendarShowHours` is false, matching the regular per-day hours
   * lines; a `null` return means nothing worth rendering - no event AND
   * (no hours data, or hours aren't a concern for this calendar).
   */
  function buildAgendaWeekendDivider(weekend, visibleRowLabels, weekendHoursByRow, calendarShowHours) {
    const weekendEvents = [];
    (visibleRowLabels || []).forEach((rowLabel) => {
      const events = (weekend.events && weekend.events[rowLabel]) || [];
      events.forEach((event) => {
        weekendEvents.push(Object.assign({ row: rowLabel }, event));
      });
    });

    const divider = document.createElement('section');
    const title = document.createElement('div');
    title.className = 'libcal-gantt-agenda__weekend-title';
    title.setAttribute('role', 'heading');
    title.setAttribute('aria-level', '3');
    title.textContent = Drupal.t('Weekend');

    if (weekendEvents.length) {
      divider.className = 'libcal-gantt-agenda__weekend event_weekend';
      divider.appendChild(title);

      const list = document.createElement('ul');
      list.className = 'libcal-gantt-agenda__list';
      weekendEvents
        .sort((a, b) => (a.day + a.startLabel).localeCompare(b.day + b.startLabel))
        .forEach((event) => {
          list.appendChild(buildAgendaWeekendEventItem(event));
        });
      divider.appendChild(list);

      return divider;
    }

    if (!calendarShowHours) {
      return null;
    }

    divider.className = 'libcal-gantt-agenda__weekend empty_weekend';
    divider.appendChild(title);

    let wroteHoursLine = false;
    (visibleRowLabels || []).forEach((rowLabel) => {
      const rowHours = weekendHoursByRow && weekendHoursByRow[rowLabel];
      const satSummary = hoursSummary(rowHours && rowHours[weekend.saturday]);
      const sunSummary = hoursSummary(rowHours && rowHours[weekend.sunday]);
      if (!satSummary && !sunSummary) {
        return;
      }
      wroteHoursLine = true;

      const line = document.createElement('div');
      line.className = 'libcal-gantt-agenda__weekend-hours-line';
      const parts = [];
      if (satSummary) {
        parts.push(Drupal.t('Sat @summary', { '@summary': satSummary }));
      }
      if (sunSummary) {
        parts.push(Drupal.t('Sun @summary', { '@summary': sunSummary }));
      }
      line.textContent = Drupal.t('@row: @parts', { '@row': rowLabel, '@parts': parts.join(' · ') });
      divider.appendChild(line);
    });

    return wroteHoursLine ? divider : null;
  }

  function buildAgendaWeekendEventItem(event) {
    const item = document.createElement('li');
    item.className = 'libcal-gantt-agenda__event';

    const link = document.createElement(event.url ? 'a' : 'div');
    link.className = 'libcal-gantt-agenda__link';
    if (event.url) {
      link.href = event.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }

    const dayAbbrev = formatDayLabel(event.day, false).split(',')[0];

    const time = document.createElement('span');
    time.className = 'libcal-gantt-agenda__time';
    time.textContent = dayAbbrev + ' ' + event.startLabel + '–' + event.endLabel;
    link.appendChild(time);

    const details = document.createElement('span');
    details.className = 'libcal-gantt-agenda__details';

    const locationText = event.location || event.row || '';
    if (locationText) {
      const location = document.createElement('span');
      location.className = 'libcal-gantt-agenda__location';
      location.textContent = locationText;
      details.appendChild(location);
    }

    const titleEl = document.createElement('span');
    titleEl.className = 'libcal-gantt-agenda__title';
    titleEl.textContent = event.title;
    details.appendChild(titleEl);

    link.appendChild(details);
    item.appendChild(link);

    return item;
  }

  /**
   * Builds the mobile agenda's "All buildings / <row> / <row>..." filter
   * row, or returns null when there's only zero/one row configured -
   * nothing to filter between. Same tab-styled button pattern as
   * buildCalendarTabs(), but this narrows which of the ALREADY-LOADED
   * data is shown (a client-side filter) rather than requesting anything
   * new from the server, so clicking an option just mutates
   * `state.agendaRowFilter` and re-renders from what's already in
   * memory.
   *
   * Exists because the mobile agenda otherwise interleaves every
   * location's events into one combined list per day - fine for a
   * single-building site, but a long scroll once there are several
   * locations each with their own events on a busy day.
   */
  function buildAgendaRowFilter(container, endpoint, state) {
    if (!Array.isArray(state.rowLabels) || state.rowLabels.length < 2) {
      return null;
    }

    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-agenda-filter';
    wrap.setAttribute('role', 'tablist');
    wrap.setAttribute('aria-label', Drupal.t('Filter by building'));

    const options = [{ label: Drupal.t('All buildings'), value: null }].concat(
      state.rowLabels.map((label) => ({ label, value: label }))
    );

    options.forEach((option) => {
      const isActive = state.agendaRowFilter === option.value;

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'libcal-gantt-agenda-filter__tab' + (isActive ? ' is-active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.textContent = option.label;
      tab.addEventListener('click', () => {
        if (state.agendaRowFilter === option.value) {
          return;
        }
        state.agendaRowFilter = option.value;
        // A different building filter changes how many days it takes to
        // reach MOBILE_INITIAL_EVENT_COUNT (narrowing to one row means
        // fewer events per day), so the agenda's revealed-day cutoff is
        // recomputed from scratch for the new filter rather than kept as
        // whatever day count happened to satisfy the old one.
        state.agendaVisibleDayCount = null;
        renderChart(container, endpoint, state);
      });

      wrap.appendChild(tab);
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

    // Falls back to the event's row (e.g. "Main Library" or whatever the
    // online row is labeled) when there's no specific room/location text
    // - most often true for online events, whose location field is
    // typically blank since a physical room doesn't apply to them.
    // Shown before the title, same order as the desktop bar (see
    // buildBar()).
    const locationText = event.location || event.row || '';
    if (locationText) {
      const location = document.createElement('span');
      location.className = 'libcal-gantt-agenda__location';
      location.textContent = locationText;
      details.appendChild(location);
    }

    const titleEl = document.createElement('span');
    titleEl.className = 'libcal-gantt-agenda__title';
    titleEl.textContent = event.title;
    details.appendChild(titleEl);

    link.appendChild(details);
    item.appendChild(link);

    return item;
  }

  /**
   * Builds the desktop grid's "Show more weekdays" control, appended
   * (alongside the mobile-only buildMobileMoreButton()) after both views.
   * Re-uses the same button/state across re-renders by looking it up in
   * the freshly-rendered DOM rather than keeping a separate reference.
   */
  function buildMoreButton(container, endpoint, state) {
    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-chart__more libcal-gantt-chart__more--desktop';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'libcal-gantt-chart__more-button';
    const increment = state.pageSize || 10;
    button.textContent = Drupal.t('Show @count more weekdays', { '@count': increment });
    button.addEventListener('click', () => {
      loadPage(container, endpoint, state, false, null, 'desktop');
    });

    wrap.appendChild(button);
    return wrap;
  }

  /**
   * Updates the loading/error state of one of the two "show more"
   * buttons - `options.variant` ('desktop' or 'mobile', default
   * 'desktop') picks which, since buildMoreButton() and
   * buildMobileMoreButton() are now two independent controls that can be
   * mid-request at different times (e.g. a phone user's own "Show more
   * events" click shouldn't disable/relabel the desktop button, and vice
   * versa - not that both are ever visible to the same viewer at once,
   * but state.loading is shared, so keeping their DOM state independent
   * avoids one view's button silently reflecting the other's request).
   */
  function setMoreButtonState(container, options) {
    const variant = options.variant || 'desktop';
    const wrap = container.querySelector('.libcal-gantt-chart__more--' + variant);
    const button = wrap && wrap.querySelector('.libcal-gantt-chart__more-button');
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
    bar.title = event.startLabel + '–' + event.endLabel
      + (event.location ? ' — ' + event.location : '')
      + ' — ' + event.title;

    if (event.url) {
      bar.href = event.url;
      bar.target = '_blank';
      bar.rel = 'noopener noreferrer';
    }

    applyBarImage(bar, event.image);

    const time = document.createElement('span');
    time.className = 'libcal-gantt__bar-time';
    time.textContent = event.startLabel + '–' + event.endLabel;
    bar.appendChild(time);

    // Location before title - now that rows group by campus rather than
    // by exact room, the specific room/location (e.g. "[Main Library]
    // Room 109") is the more useful line to read first, same order the
    // mobile agenda uses (see buildAgendaItem()).
    if (event.location) {
      const location = document.createElement('span');
      location.className = 'libcal-gantt__bar-location';
      location.textContent = event.location;
      bar.appendChild(location);
    }

    const label = document.createElement('span');
    label.className = 'libcal-gantt__bar-label';
    label.textContent = event.title;
    bar.appendChild(label);

    return bar;
  }

  /**
   * Applies a LibCal "Featured image" (see GanttEventsController::
   * prepareEvent()'s `image` field) as a bar's CSS background, via the
   * `--libcal-gantt-bar-image` custom property the `.libcal-gantt__bar--
   * has-image` rule (gantt-timeline.css) reads - the actual gradient/
   * positioning lives entirely in CSS so a theme can override the look;
   * this just supplies the one per-event value CSS can't know on its
   * own. Does nothing (leaves the bar exactly as before this feature) for
   * an event with no image, which is the common case for a plain
   * calendar event that was never given one.
   */
  function applyBarImage(bar, imageUrl) {
    if (!imageUrl) {
      return;
    }
    bar.classList.add('libcal-gantt__bar--has-image');
    bar.style.setProperty('--libcal-gantt-bar-image', 'url(' + JSON.stringify(imageUrl) + ')');
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