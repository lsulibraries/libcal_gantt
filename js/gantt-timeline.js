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

  /**
   * How many day cards the homepage variant reveals at a time - both on
   * first render and per "Show more days" click (buildHomepageMoreButton()).
   * Three by default because that is exactly the width of the card grid on
   * a wide screen, so every click adds one visually complete row instead
   * of a ragged partial one. Overridable per block instance through the
   * block's "Days per reveal" setting - see readOptions().
   */
  const HOMEPAGE_DAYS_PER_REVEAL = 3;

  /**
   * localStorage key holding the visitor's own light/dark choice (see
   * buildThemeToggle()). Persisted rather than kept in memory so the
   * choice survives leaving the homepage and coming back, which is the
   * normal way this block is encountered. A missing or unreadable value
   * just falls back to the block's configured theme, so private-mode and
   * storage-blocked browsers degrade to config instead of erroring.
   */
  const THEME_STORAGE_KEY = 'libcal-gantt-theme';

  /**
   * How many event notes the desktop weekend accessory column will list
   * individually in one row's cell before collapsing the rest into a
   * "+N more" line (see buildWeekendCell()).
   *
   * The weekend column is the narrowest track in the grid - 88px, down to
   * 64px at the smallest container step - and a CSS Grid row is as tall
   * as its tallest cell, so an uncapped list of long event titles in this
   * one cell can set the height of an entire location row on its own.
   * Two notes plus a count is about what fits beside a normal-height row
   * without dominating it. Nothing is lost: the collapsed titles are in
   * the "+N more" line's tooltip, and the mobile agenda's weekend
   * divider still lists every occurrence in full.
   */
  const WEEKEND_MAX_NOTES = 2;

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
  /**
   * Reads the per-instance display settings the block plugin wrote onto
   * the container as data-* attributes (see GanttChartBlock::build()).
   *
   * Deliberately data-* on the element rather than drupalSettings: these
   * settings are PER INSTANCE, and drupalSettings is one global bag keyed
   * by module, so two placements of this block on a single page - the
   * homepage teaser plus a full grid further down, which is precisely the
   * layout this variant exists to enable - would silently overwrite each
   * other's settings there. The endpoint stays in drupalSettings because
   * it genuinely is global: one route for the whole site.
   *
   * Every default below reproduces the module's pre-existing behaviour,
   * so a block instance placed before these settings existed - stored
   * config has none of these keys, so the container carries none of these
   * attributes - renders exactly the full grid it always did.
   */
  function readOptions(container) {
    const data = container.dataset || {};
    const days = parseInt(data.homepageDays, 10);

    return {
      // 'grid' (original wide grid + mobile agenda) or 'homepage' (the
      // compact day-card teaser). Anything unrecognised falls back to
      // 'grid'.
      renderMode: data.renderMode === 'homepage' ? 'homepage' : 'grid',
      homepageDays: (Number.isFinite(days) && days > 0) ? days : HOMEPAGE_DAYS_PER_REVEAL,
      // Heading above the homepage cards. An empty string renders no
      // heading element at all, so a site whose surrounding layout
      // already provides a section title is not forced into a duplicate.
      chartTitle: typeof data.chartTitle === 'string' ? data.chartTitle : '',
      // Target of the "Full calendar" call to action. Empty means the
      // link is not rendered - better than a link to nowhere.
      fullCalendarUrl: typeof data.fullCalendarUrl === 'string' ? data.fullCalendarUrl : '',
      showLegend: data.showLegend !== '0',
      // 'dark' | 'light' | 'auto' - the STARTING theme; 'auto' follows the
      // visitor's OS-level prefers-color-scheme. A stored visitor choice
      // outranks all three - see resolveInitialTheme().
      theme: (data.theme === 'light' || data.theme === 'auto') ? data.theme : 'dark',
      allowThemeToggle: data.themeToggle !== '0',
    };
  }

  function initChart(container, endpoint) {
    const options = readOptions(container);
    const state = {
      // Per-instance display settings - see readOptions().
      options: options,
      // How many of state.days the homepage variant currently reveals,
      // growing by options.homepageDays per "Show more days" click (see
      // loadMoreHomepageDays()). Unused by the grid variant, which pages
      // by fetching rather than by revealing.
      homepageVisibleDays: options.homepageDays,
      // The RESOLVED theme in effect - always 'dark' or 'light', never
      // 'auto', which is settled once up front against the OS preference.
      // Kept on state so that a re-render (including the periodic
      // LIVE_REFRESH_INTERVAL_MS one, which rebuilds the entire DOM)
      // re-applies the visitor's choice instead of snapping back to the
      // configured default.
      theme: resolveInitialTheme(options),
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
   * Decides which theme a freshly-initialised chart starts in, in
   * precedence order: a stored visitor choice, then the block's
   * configured theme, resolving 'auto' against prefers-color-scheme. The
   * visitor's own click outranks site config because it is a more
   * specific and more recent expression of the same preference - and
   * because someone who deliberately switched to the light theme last
   * visit should not have to do it again every time they load the
   * homepage.
   */
  function resolveInitialTheme(options) {
    // A stored choice is only honoured when this block actually OFFERS the
    // toggle. Otherwise a visitor who picked light on a page that offers
    // the switch would silently re-theme a block whose editor deliberately
    // pinned it - and with no control rendered, no way to undo it.
    if (options.allowThemeToggle) {
      const stored = readStoredTheme();
      if (stored) {
        return stored;
      }
    }
    if (options.theme === 'auto') {
      return prefersLightScheme() ? 'light' : 'dark';
    }
    return options.theme;
  }

  function prefersLightScheme() {
    return typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: light)').matches;
  }

  /**
   * Both storage helpers swallow their own errors. localStorage throws
   * rather than returning null in Safari private browsing and anywhere
   * site-data storage is blocked, and a theme preference is far too minor
   * a nicety to let it take the whole chart down with it.
   */
  function readStoredTheme() {
    try {
      const value = window.localStorage.getItem(THEME_STORAGE_KEY);
      return (value === 'light' || value === 'dark') ? value : null;
    }
    catch (error) {
      return null;
    }
  }

  function storeTheme(theme) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
    catch (error) {
      // The preference simply will not persist - see readStoredTheme().
    }
  }

  /**
   * Puts the resolved theme into effect.
   *
   * The light palette is a pure TOKEN override (see "Light palette" in
   * gantt-timeline.css): this toggles one class on the chart root and
   * every colour in the module re-resolves through the custom properties,
   * because no rule in the stylesheet hardcodes a colour. That is why a
   * second theme needed no new component rules at all - only a new block
   * of values.
   *
   * Also mirrors the value onto data-libcal-gantt-theme so the host theme
   * can hook its own surrounding styling (matching the section background
   * the block sits on, say) without having to watch for a class.
   */
  function applyTheme(container, theme) {
    container.classList.toggle('libcal-gantt-chart--light', theme === 'light');
    container.classList.toggle('libcal-gantt-chart--dark', theme !== 'light');
    container.setAttribute('data-libcal-gantt-theme', theme);
  }

  /**
   * Builds the light/dark switch, or null when the block is configured
   * not to offer one.
   *
   * One two-state button rather than a pair of options: there are exactly
   * two themes, so a control whose label says what it will DO ("Light")
   * is both smaller and less ambiguous than two controls where the
   * visitor must work out which is currently active. aria-pressed carries
   * the state for screen readers and the glyph is aria-hidden so it is
   * not announced as a separate meaningless character beside that label.
   *
   * Clicking re-renders rather than only swapping the class, so the
   * button's own label and pressed state - rebuilt from state.theme -
   * stay truthful.
   */
  function buildThemeToggle(container, endpoint, state) {
    if (!state.options.allowThemeToggle) {
      return null;
    }

    const isLight = state.theme === 'light';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'libcal-gantt-theme-toggle';
    button.setAttribute('aria-pressed', isLight ? 'true' : 'false');
    button.title = isLight ? Drupal.t('Switch to the dark theme') : Drupal.t('Switch to the light theme');

    const icon = document.createElement('span');
    icon.className = 'libcal-gantt-theme-toggle__icon';
    icon.setAttribute('aria-hidden', 'true');
    // Plain text glyphs, not an icon font or inline SVG - the module
    // ships no icon assets, and these render everywhere without adding a
    // dependency or an extra request.
    icon.textContent = isLight ? '◑' : '◐';
    button.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'libcal-gantt-theme-toggle__label';
    label.textContent = isLight ? Drupal.t('Dark') : Drupal.t('Light');
    button.appendChild(label);

    button.addEventListener('click', () => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      storeTheme(state.theme);
      applyTheme(container, state.theme);
      renderChart(container, endpoint, state);
    });

    return button;
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

    // Re-applied on every render, not once at init: the periodic
    // LIVE_REFRESH_INTERVAL_MS re-render and every "Show more" rebuild the
    // container's children, and a theme switch re-renders on purpose so
    // the toggle's own label stays truthful - see buildThemeToggle().
    applyTheme(container, state.theme);

    const isHomepage = state.options.renderMode === 'homepage';
    container.classList.toggle('libcal-gantt-chart--homepage', isHomepage);

    const tabs = buildCalendarTabs(container, endpoint, state);

    // In homepage mode the tabs and the theme toggle both live inside the
    // card grid's own header bar (see buildHomepageHeader()), on one line
    // with the heading and the "Full calendar" link, rather than stacked
    // above it as separate strips - the whole point of the variant is that
    // it occupies as little homepage height as possible.
    if (!isHomepage) {
      const toggle = buildThemeToggle(container, endpoint, state);
      if (toggle) {
        // Only introduces a wrapper when there is actually a second
        // control to align the tabs against. With no toggle configured the
        // tabs are appended bare, exactly as before this variant existed,
        // so a block instance that opts out of everything new produces
        // byte-identical DOM to the original grid.
        const toolbar = document.createElement('div');
        toolbar.className = 'libcal-gantt-toolbar';
        if (tabs) {
          toolbar.appendChild(tabs);
        }
        toolbar.appendChild(toggle);
        container.appendChild(toolbar);
      }
      else if (tabs) {
        container.appendChild(tabs);
      }
    }

    if (!state.days.length) {
      container.appendChild(emptyMessage(Drupal.t('No upcoming dates to display.')));
      return;
    }

    const rows = buildRows(state.rowLabels, state.events);
    const scale = {
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

    // One renderer or the other, never both - `renderMode` selects the
    // whole view, so this branch is the only place either view is built.
    //
    // An unconditional buildGrid()/buildAgenda() pair used to sit here,
    // left over from before the homepage variant existed and never removed
    // when the if/else below was added. It ran in BOTH modes, so the
    // homepage rendered the full ten-day grid first and then appended the
    // day cards underneath it - two views of the same data stacked in one
    // block, which is exactly what the banner was showing.
    if (isHomepage) {
      // One responsive renderer, not the grid/agenda pair: the card grid
      // collapses from three columns to one on a phone through CSS alone,
      // so there is no second view to keep in sync and only one "show
      // more" control to reason about.
      container.appendChild(buildHomepage(container, endpoint, state, calendarShowHours));
      container.appendChild(buildHomepageMoreButton(container, endpoint, state));
    }
    else {
      container.appendChild(buildGrid(state.days, rows, scale, calendarShowHours));
      container.appendChild(buildAgenda(container, endpoint, state, calendarShowHours));
      // Two separate "show more" controls, like the grid/agenda split
      // above - both always in the DOM, CSS decides which is visible. The
      // desktop one pages by weekday count; the mobile one pages by event
      // count instead, since a day range that is fine on the wide grid can
      // still be a very long phone scroll - see buildMobileMoreButton().
      container.appendChild(buildMoreButton(container, endpoint, state));
      container.appendChild(buildMobileMoreButton(container, endpoint, state));
    }

    // Deliberately OUTSIDE the chart element, after the "show more"
    // controls: the legend explains the chart, it is not part of it. Kept
    // out of the grid/card DOM so it can never be mistaken for a row, a
    // day column or an event, and so screen readers reach the actual
    // events first rather than wading through a key to get to them.
    if (state.options.showLegend) {
      container.appendChild(buildLegend(state, calendarShowHours, isHomepage));
    }
  }

  /**
   * Builds the homepage variant: a compact grid of day cards, today
   * first, sized to sit above the fold on the LSU Libraries homepage
   * rather than to survey a whole fortnight.
   *
   * This is a genuinely different reading task from the full grid, which
   * is why it is a different renderer rather than a restyling of the same
   * DOM. The grid answers "when across the next two weeks is the Hill
   * Memorial room free?" - a two-dimensional, location-by-day question
   * that needs a table. A homepage visitor is asking "is anything on
   * today?", which is a short list. Reusing the grid here would mean
   * paying for a location axis that the answer does not need, in the
   * scarcest vertical space on the site.
   */
  function buildHomepage(container, endpoint, state, calendarShowHours) {
    const wrap = document.createElement('section');
    wrap.className = 'libcal-gantt-home';

    wrap.appendChild(buildHomepageHeader(container, endpoint, state));

    const grid = document.createElement('div');
    grid.className = 'libcal-gantt-home__days';

    const days = state.days.slice(0, state.homepageVisibleDays);

    // Same segments-based grouping the agenda uses: a multi-day event
    // contributes one entry per day it covers, so a week-long display
    // shows up on each of the days actually on screen rather than only on
    // the day it started - which for a long-running exhibit is usually
    // some date well before the visitor is looking.
    const eventsByDay = new Map();
    days.forEach((day) => eventsByDay.set(day, []));
    state.events.forEach((event) => {
      Object.keys(event.segments || {}).forEach((day) => {
        if (eventsByDay.has(day)) {
          eventsByDay.get(day).push({ event: event, segment: event.segments[day] });
        }
      });
    });

    const weekendByAfter = new Map();
    (state.weekends || []).forEach((weekend) => weekendByAfter.set(weekend.after, weekend));

    days.forEach((day) => {
      grid.appendChild(buildHomepageDayCard(day, eventsByDay.get(day) || [], state, calendarShowHours));

      // A weekend is not a day column here (the loaded day list skips
      // Saturday and Sunday), so it renders as a full-width strip after
      // the Friday card instead of competing for one of the three card
      // slots - a weekend with nothing on and normal hours is worth one
      // quiet line, not a third of the visitor's attention.
      const weekend = weekendByAfter.get(day);
      if (weekend) {
        const strip = buildHomepageWeekendStrip(weekend, state, calendarShowHours);
        if (strip) {
          grid.appendChild(strip);
        }
      }
    });

    wrap.appendChild(grid);

    if (calendarShowHours) {
      const status = buildHomepageStatusBar(state);
      if (status) {
        wrap.appendChild(status);
      }
    }

    return wrap;
  }

  /**
   * The homepage header bar: heading, the covered date range, the
   * calendar tabs, the theme toggle and the "Full calendar" call to
   * action, all on one line (wrapping on narrow screens).
   *
   * The date range is spelled out because the card grid deliberately
   * shows only a few days - without it, "This week at the Libraries" over
   * three cards reads as a claim that the week contains three days.
   */
  function buildHomepageHeader(container, endpoint, state) {
    const header = document.createElement('header');
    header.className = 'libcal-gantt-home__header';

    const headings = document.createElement('div');
    headings.className = 'libcal-gantt-home__headings';

    if (state.options.chartTitle) {
      const title = document.createElement('h2');
      title.className = 'libcal-gantt-home__title';
      title.textContent = state.options.chartTitle;
      headings.appendChild(title);
    }

    const days = state.days.slice(0, state.homepageVisibleDays);
    if (days.length) {
      const range = document.createElement('p');
      range.className = 'libcal-gantt-home__range';
      range.textContent = days.length === 1
        ? formatDayLabel(days[0], true)
        : Drupal.t('@from through @to', {
          '@from': formatDayLabel(days[0], true),
          '@to': formatDayLabel(days[days.length - 1], true),
        });
      headings.appendChild(range);
    }

    header.appendChild(headings);

    const controls = document.createElement('div');
    controls.className = 'libcal-gantt-home__controls';

    const tabs = buildCalendarTabs(container, endpoint, state);
    if (tabs) {
      controls.appendChild(tabs);
    }

    const toggle = buildThemeToggle(container, endpoint, state);
    if (toggle) {
      controls.appendChild(toggle);
    }

    if (state.options.fullCalendarUrl) {
      const link = document.createElement('a');
      link.className = 'libcal-gantt-home__cta';
      link.href = state.options.fullCalendarUrl;
      // No target="_blank" here, unlike the individual event links: this
      // one goes to another page of the library's own site, where hijacking
      // the visitor's tab management would be presumptuous. Event links
      // point out to LibCal, so those keep opening in a new tab.
      link.textContent = Drupal.t('Full calendar');
      const chevron = document.createElement('span');
      chevron.className = 'libcal-gantt-home__cta-arrow';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '→';
      link.appendChild(chevron);
      controls.appendChild(link);
    }

    if (controls.childNodes.length) {
      header.appendChild(controls);
    }

    return header;
  }

  /**
   * One day card. Carries the same past_date/today_date/future_date state
   * classes the grid cells use, so the today highlight is one shared set
   * of tokens across both variants rather than a second parallel
   * mechanism to keep in sync.
   */
  function buildHomepageDayCard(day, entries, state, calendarShowHours) {
    const status = dayStatus(day);

    const card = document.createElement('article');
    card.className = 'libcal-gantt-home__day ' + status + '_date';
    card.setAttribute('data-day-status', status);
    if (status === 'today') {
      card.setAttribute('aria-current', 'date');
    }

    const head = document.createElement('header');
    head.className = 'libcal-gantt-home__day-head';

    const name = document.createElement('span');
    name.className = 'libcal-gantt-home__day-name';
    name.textContent = formatDayLabel(day, true);
    head.appendChild(name);

    if (status === 'today') {
      // A visible word, not just a colour: the today highlight has to
      // survive greyscale printing, colour-vision deficiency and a theme
      // that overrides the accent token to something subtle.
      const badge = document.createElement('span');
      badge.className = 'libcal-gantt-home__today-badge';
      badge.textContent = Drupal.t('Today');
      head.appendChild(badge);
    }

    card.appendChild(head);

    // All-day and multi-day items sort above timed ones, then timed items
    // by start time. An ongoing exhibit is context for the whole day, so
    // it belongs at the top as a header of sorts - not wherever midnight
    // happens to place it, which is the same result but for the wrong
    // reason and breaks as soon as a feed reports a real start time.
    const sorted = entries.slice().sort((a, b) => {
      const aAll = isAllDayLabel(a.event.startLabel, a.event.endLabel) ? 0 : 1;
      const bAll = isAllDayLabel(b.event.startLabel, b.event.endLabel) ? 0 : 1;
      if (aAll !== bAll) {
        return aAll - bAll;
      }
      return a.segment.startHour - b.segment.startHour;
    });

    if (sorted.length) {
      const list = document.createElement('ul');
      list.className = 'libcal-gantt-home__list';
      sorted.forEach((entry) => list.appendChild(buildHomepageItem(entry.event)));
      card.appendChild(list);
    }
    else {
      const empty = document.createElement('p');
      empty.className = 'libcal-gantt-home__empty';
      empty.textContent = Drupal.t('Nothing scheduled');
      card.appendChild(empty);
    }

    // Hours are shown on the card only when it has no events to show.
    // On a busy day the footer status bar already answers "is the library
    // open right now?" and repeating the full open-close range on every
    // card would crowd out the events themselves; on an empty card the
    // line is genuinely useful and fills space that would otherwise read
    // as a rendering failure.
    if (calendarShowHours && !sorted.length) {
      appendHomepageHoursLine(card, day, state);
    }

    return card;
  }

  function appendHomepageHoursLine(card, day, state) {
    const parts = [];
    (state.rowLabels || []).forEach((rowLabel) => {
      const rowHours = state.hours && state.hours[rowLabel];
      const summary = hoursSummary(rowHours && rowHours[day]);
      if (summary) {
        parts.push(Drupal.t('@row @summary', { '@row': rowLabel, '@summary': summary }));
      }
    });
    if (!parts.length) {
      return;
    }
    const line = document.createElement('p');
    line.className = 'libcal-gantt-home__day-hours';
    line.textContent = parts.join(' · ');
    card.appendChild(line);
  }

  /**
   * One event inside a day card: time (or an "Ongoing" chip), title, then
   * location. Title before location here, unlike the desktop bar - a card
   * gives the title room to be read as a heading, so it leads, with the
   * room as its subtitle.
   */
  function buildHomepageItem(event) {
    const allDay = isAllDayLabel(event.startLabel, event.endLabel);

    const item = document.createElement('li');
    item.className = 'libcal-gantt-home__item' + (allDay ? ' libcal-gantt-home__item--all-day' : '');

    const link = document.createElement(event.url ? 'a' : 'div');
    link.className = 'libcal-gantt-home__link';
    if (event.url) {
      link.href = event.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }

    const time = document.createElement('span');
    time.className = 'libcal-gantt-home__time';
    if (allDay) {
      // "Ongoing" rather than "All day": the events that hit this branch
      // are overwhelmingly exhibits, displays and donation drives that run
      // for weeks, and "All day" invites the reading that they end at
      // midnight tonight.
      time.classList.add('libcal-gantt-home__time--chip');
      time.textContent = Drupal.t('Ongoing');
    }
    else {
      time.textContent = event.startLabel + '–' + event.endLabel;
    }
    link.appendChild(time);

    const body = document.createElement('span');
    body.className = 'libcal-gantt-home__body';

    const title = document.createElement('span');
    title.className = 'libcal-gantt-home__item-title';
    title.textContent = event.title;
    body.appendChild(title);

    const locationText = event.location || event.row || '';
    if (locationText) {
      const location = document.createElement('span');
      location.className = 'libcal-gantt-home__item-location';
      location.textContent = locationText;
      body.appendChild(location);
    }

    link.appendChild(body);
    item.appendChild(link);

    return item;
  }

  /**
   * The full-width weekend strip that follows a Friday card. Returns null
   * when there is genuinely nothing to say - no weekend events and no
   * hours worth printing - rather than an empty band, matching how
   * buildAgendaWeekendDivider() suppresses itself.
   */
  function buildHomepageWeekendStrip(weekend, state, calendarShowHours) {
    const events = [];
    (state.rowLabels || []).forEach((rowLabel) => {
      const rowEvents = (weekend.events && weekend.events[rowLabel]) || [];
      rowEvents.forEach((event) => events.push(event));
    });

    const hourLines = [];
    if (calendarShowHours) {
      (state.rowLabels || []).forEach((rowLabel) => {
        const rowHours = state.weekendHours && state.weekendHours[rowLabel];
        const sat = hoursSummary(rowHours && rowHours[weekend.saturday]);
        const sun = hoursSummary(rowHours && rowHours[weekend.sunday]);
        if (!sat && !sun) {
          return;
        }
        const parts = [];
        if (sat) {
          parts.push(Drupal.t('Sat @summary', { '@summary': sat }));
        }
        if (sun) {
          parts.push(Drupal.t('Sun @summary', { '@summary': sun }));
        }
        hourLines.push(Drupal.t('@row: @parts', { '@row': rowLabel, '@parts': parts.join(' · ') }));
      });
    }

    if (!events.length && !hourLines.length) {
      return null;
    }

    const strip = document.createElement('div');
    strip.className = 'libcal-gantt-home__weekend '
      + (events.length ? 'event_weekend' : 'empty_weekend');

    const label = document.createElement('span');
    label.className = 'libcal-gantt-home__weekend-label';
    label.textContent = Drupal.t('Weekend');
    strip.appendChild(label);

    const detail = document.createElement('div');
    detail.className = 'libcal-gantt-home__weekend-detail';

    events.forEach((event) => {
      const dayAbbrev = formatDayLabel(event.day, false).split(',')[0];
      const entry = document.createElement(event.url ? 'a' : 'span');
      entry.className = 'libcal-gantt-home__weekend-event';
      if (event.url) {
        entry.href = event.url;
        entry.target = '_blank';
        entry.rel = 'noopener noreferrer';
      }
      entry.textContent = isAllDayLabel(event.startLabel, event.endLabel)
        ? dayAbbrev + ' · ' + event.title
        : dayAbbrev + ' ' + event.startLabel + ' · ' + event.title;
      detail.appendChild(entry);
    });

    hourLines.forEach((text) => {
      const line = document.createElement('span');
      line.className = 'libcal-gantt-home__weekend-hours';
      line.textContent = text;
      detail.appendChild(line);
    });

    strip.appendChild(detail);
    return strip;
  }

  /**
   * The live "open right now" footer, one pill per location row. This is
   * the single piece of information a homepage visitor is most likely to
   * have come for, and it is the reason the variant re-renders on
   * LIVE_REFRESH_INTERVAL_MS - a pill reading "Open now" an hour after
   * closing is worse than no pill at all.
   *
   * Returns null when no row has usable hours for today, so a
   * misconfigured or unreachable hours feed degrades to no footer rather
   * than to a row of empty pills.
   */
  function buildHomepageStatusBar(state) {
    const bar = document.createElement('div');
    bar.className = 'libcal-gantt-home__status';

    let wrote = false;
    (state.rowLabels || []).forEach((rowLabel) => {
      const status = computeRowOpenStatus(rowLabel, state.hours);
      if (!status) {
        return;
      }
      wrote = true;

      const pill = document.createElement('span');
      pill.className = 'libcal-gantt-home__status-pill '
        + (status === 'open' ? 'now_open' : 'now_closed');

      const dot = document.createElement('span');
      dot.className = 'libcal-gantt-home__status-dot';
      dot.setAttribute('aria-hidden', 'true');
      pill.appendChild(dot);

      const text = document.createElement('span');
      text.textContent = status === 'open'
        ? Drupal.t('@row: open now', { '@row': rowLabel })
        : Drupal.t('@row: closed now', { '@row': rowLabel });
      pill.appendChild(text);

      bar.appendChild(pill);
    });

    return wrote ? bar : null;
  }

  /**
   * The homepage variant's own "Show more days" control, separate from
   * the grid's two - it reveals days DOWNWARD (a further row of cards
   * appended beneath the current ones) rather than paging a horizontal
   * axis, so its label and its increment both talk about days rather than
   * weekdays or events.
   *
   * Reveals from already-loaded data when it can and only hits the
   * network when it must, which is why loadMoreHomepageDays() is split out
   * below: after the first page there are usually several more loaded days
   * in state.days than the three on screen, and a fetch to display data
   * the browser is already holding would be a pointless spinner.
   */
  function buildHomepageMoreButton(container, endpoint, state) {
    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-chart__more libcal-gantt-chart__more--homepage';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'libcal-gantt-chart__more-button';
    const increment = state.options.homepageDays;
    button.textContent = Drupal.t('Show @count more days', { '@count': increment });
    button.addEventListener('click', () => {
      loadMoreHomepageDays(container, endpoint, state);
    });

    wrap.appendChild(button);
    return wrap;
  }

  function loadMoreHomepageDays(container, endpoint, state) {
    if (state.loading) {
      return;
    }

    const increment = state.options.homepageDays;
    const target = state.homepageVisibleDays + increment;

    if (state.days.length >= target) {
      state.homepageVisibleDays = target;
      renderChart(container, endpoint, state);
      return;
    }

    // Not enough loaded days to satisfy the click - fetch a page, and
    // raise the reveal count inside onLoaded (before the render that
    // loadPage() triggers) so the newly-arrived days appear already
    // revealed instead of needing a second click.
    loadPage(container, endpoint, state, false, () => {
      state.homepageVisibleDays = Math.min(target, state.days.length) || target;
    }, 'homepage');
  }

  /**
   * Builds the key explaining what the chart's colours and textures mean.
   *
   * Worth having because the chart encodes several things visually and
   * names none of them: the today band, the ongoing/all-day treatment,
   * the open-now indicator and (in the grid) the spanning multi-day bar.
   * A visitor can usually infer each one, but "usually" is doing a lot of
   * work for the one item that is a different colour for a reason nobody
   * stated.
   *
   * Only lists what the current mode and calendar actually render: the
   * multi-day and weekend entries are grid-only, and the open-now entry is
   * suppressed for a calendar flagged "|no-hours", whose events are not
   * tied to building hours at all. A legend describing swatches that are
   * not on screen is worse than no legend.
   */
  function buildLegend(state, calendarShowHours, isHomepage) {
    const legend = document.createElement('div');
    legend.className = 'libcal-gantt-legend';
    legend.setAttribute('role', 'list');
    legend.setAttribute('aria-label', Drupal.t('What the colours mean'));

    const items = [
      { modifier: 'event', label: Drupal.t('Scheduled event') },
      { modifier: 'all-day', label: Drupal.t('Ongoing / all day') },
      { modifier: 'today', label: Drupal.t('Today') },
    ];

    if (!isHomepage) {
      items.push({ modifier: 'multi', label: Drupal.t('Runs across several days') });
      items.push({ modifier: 'weekend', label: Drupal.t('Weekend') });
    }

    if (calendarShowHours) {
      items.push({ modifier: 'open', label: Drupal.t('Open right now') });
      items.push({ modifier: 'closed', label: Drupal.t('Closed') });
    }

    items.forEach((item) => {
      const entry = document.createElement('span');
      entry.className = 'libcal-gantt-legend__item';
      entry.setAttribute('role', 'listitem');

      const swatch = document.createElement('span');
      // The swatch is the only place in the legend that carries meaning
      // visually, and it is decorative to a screen reader - the adjacent
      // text already says what it stands for.
      swatch.className = 'libcal-gantt-legend__swatch libcal-gantt-legend__swatch--' + item.modifier;
      swatch.setAttribute('aria-hidden', 'true');
      entry.appendChild(swatch);

      const text = document.createElement('span');
      text.className = 'libcal-gantt-legend__label';
      text.textContent = item.label;
      entry.appendChild(text);

      legend.appendChild(entry);
    });

    return legend;
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
    // Resolved once per block rather than per cell: dayStatus() calls
    // todayDateKey() anyway, and the today band needs the raw key too
    // (for the weekend column, which covers two dates, and for the
    // bottom edge on the last row).
    const todayKey = todayDateKey();

    rows.forEach((row, rowIndex) => {
      const isLastRow = rowIndex === rows.length - 1;
      const { runs, consumedByEvent } = rowMerges[row.label];
      const spans = clipRunsToChunk(runs, chunk.startIndex, chunkDays, dayColumns);
      // Extends a run (or promotes a solo event) across a weekend
      // accessory column immediately to its right when LibCal has the
      // same recurring thing scheduled that Saturday/Sunday too - see
      // applyWeekendFlow(). Mutates `spans` (may append synthetic
      // single-day-plus-weekend entries), so subRowCount below must be
      // computed after this call.
      const { absorbedByWeekend, promotedEvents } = applyWeekendFlow(row, plan, spans, consumedByEvent);
      const subRowCount = spans.length + 1;

      const rowHeader = document.createElement('div');
      rowHeader.className = 'libcal-gantt__row-header';
      // A row with multi-day bars occupies several grid sub-rows, which
      // makes a vertically-centred label float in the middle of a tall
      // block of cells, detached from the first thing it labels - see
      // .libcal-gantt__row-header--multi in gantt-timeline.css.
      if (subRowCount > 1) {
        rowHeader.classList.add('libcal-gantt__row-header--multi');
      }
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
      //
      // The background fillers go in FIRST, before the bars, so that
      // (same z-index, so painting follows DOM order) every bar paints
      // on top of them - see buildSpanRowFillers() for why a spanning
      // sub-row needs a background at all.
      buildSpanRowFillers(block, plan, spans, gridLine, todayKey);

      spans.forEach((span, idx) => {
        const bar = buildSpanningBar(span.run, span.flowsWeekend);
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
          const absorbedKeys = absorbedByWeekend.get(track.weekend);
          const cell = buildWeekendCell(row, track.weekend, weekendHoursForRow, calendarShowHours, absorbedKeys);
          // A weekend column covers two dates, so it is "today" if
          // either of them is - keeps the today band unbroken when
          // somebody looks at the chart on a Saturday or Sunday.
          if (track.weekend.saturday === todayKey || track.weekend.sunday === todayKey) {
            cell.classList.add('today_date');
          }
          cell.style.gridRow = String(dayCellsLine);
          cell.style.gridColumn = String(track.col);
          block.appendChild(cell);
          return;
        }

        const day = track.day;
        const dayCell = document.createElement('div');
        dayCell.className = 'libcal-gantt__day-cell';
        dayCell.dataset.date = day;
        // past_date / today_date / future_date, the same classes the day
        // header above gets - this is the half that makes today read as a
        // highlighted COLUMN rather than just a highlighted header. Every
        // body row in that column carries it, including the second row
        // of the table (the first location row) and the background-only
        // fillers in any multi-day bar's sub-row.
        applyDayStateClasses(dayCell, day);
        if (day === todayKey && isLastRow) {
          // Lets the tint close itself off with a bottom edge instead of
          // running out mid-table.
          dayCell.classList.add('is-today-last');
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
          // Excludes a solo event that applyWeekendFlow() just promoted
          // into its own weekend-flowing spanning bar above, so it isn't
          // ALSO rendered a second time inside this day's normal cell.
          .filter((event) => !promotedEvents.has(event))
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
   * Fills in the background of a row's spanning-bar sub-rows.
   *
   * A spanning bar (buildSpanningBar()) is the ONLY grid item in its own
   * sub-row, placed with an explicit `grid-column: start / span N`. Every
   * column that bar doesn't cover therefore had no grid item at all -
   * not an empty cell, no DOM whatsoever - so the browser painted
   * nothing there and whatever sits behind the block showed straight
   * through. On the LSU homepage, where this block is dropped over the
   * banner photo, that meant a ragged translucent band beside every
   * multi-day or all-day event, which is the most visible half of the
   * "an all-day event breaks the styling" report. It also broke the
   * table's vertical rules, so the columns stopped lining up visually
   * across a row that happened to contain a multi-day event.
   *
   * These fillers are background-only: no content, no min-height (see
   * `--filler` in gantt-timeline.css), so they can never make a sub-row
   * taller than the bar in it. They carry the same day-state classes as
   * a real day cell so today's highlight band stays unbroken through a
   * row's spanning sub-rows, and they are appended BEFORE the bars so
   * every bar paints on top of them.
   *
   * A cheaper alternative would be a single opaque background on
   * .libcal-gantt-block (which the CSS also now sets, as a backstop for
   * any area no cell covers at all). That alone would stop the
   * see-through, but not restore the column rules or extend the today
   * band, so both are done.
   */
  function buildSpanRowFillers(block, plan, spans, gridLine, todayKey) {
    if (!spans.length) {
      return;
    }

    // Which columns are already covered by a bar, per sub-row, so a
    // filler is never placed underneath one - it would be invisible, and
    // a stray extra grid item in the same area is one more thing to go
    // wrong later.
    const covered = spans.map((span) => {
      const cols = new Set();
      for (let i = 0; i < span.gridColSpan; i++) {
        cols.add(span.startGridCol + i);
      }
      return cols;
    });

    spans.forEach((span, idx) => {
      plan.forEach((track) => {
        if (covered[idx].has(track.col)) {
          return;
        }

        const filler = document.createElement('div');
        if (track.type === 'weekend') {
          filler.className = 'libcal-gantt__weekend-cell libcal-gantt__weekend-cell--filler';
          if (track.weekend.saturday === todayKey || track.weekend.sunday === todayKey) {
            filler.classList.add('today_date');
          }
        }
        else if (track.type === 'pad') {
          // A short final block's unused columns should stay blank
          // rather than being painted in - same reasoning as
          // buildPaddingCell().
          filler.className = 'libcal-gantt__day-cell libcal-gantt__day-cell--empty';
        }
        else {
          filler.className = 'libcal-gantt__day-cell libcal-gantt__day-cell--filler';
          applyDayStateClasses(filler, track.day);
        }
        // Presentational only - there is nothing here for a screen
        // reader to read, and the row's real content is in the day-cells
        // sub-row below.
        filler.setAttribute('aria-hidden', 'true');
        filler.style.gridRow = String(gridLine + idx);
        filler.style.gridColumn = String(track.col);
        block.appendChild(filler);
      });
    });
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
      track.type === 'weekend'
        ? 'var(--libcal-gantt-weekend-width, 88px)'
        // The day-column floor is a custom property rather than a literal
        // so gantt-timeline.css's container queries can step it down as
        // the module's own width shrinks - that's what keeps every column
        // fitting instead of overflowing into a horizontal scroll. The
        // `1fr` max is what lets the columns share whatever room is left
        // once the label (and any weekend) column is accounted for.
        : 'minmax(var(--libcal-gantt-day-min-width, 90px), 1fr)'
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
   *
   * `absorbedKeys` (from applyWeekendFlow()) is the set of this row's
   * weekend events that turned out to be the same recurring thing as a
   * bar ending on the Friday just before this weekend - those already
   * flow across this column as part of that bar (see applyWeekendFlow()),
   * so they're filtered out here rather than ALSO listed as a separate
   * note, which would just repeat the same event twice in two visually
   * disconnected styles. A row left with nothing else to show this way
   * still correctly falls back to `empty_weekend` (hours), exactly like a
   * weekend with no events at all - the flowing bar above already covers
   * the "something's happening" signal, same as a weekday's hours caption
   * still shows underneath a spanning multi-day bar.
   */
  function buildWeekendCell(row, weekend, weekendHoursForRow, calendarShowHours, absorbedKeys) {
    const cell = document.createElement('div');
    cell.className = 'libcal-gantt__weekend-cell';

    const events = ((weekend.events && weekend.events[row.label]) || [])
      .filter((event) => !absorbedKeys || !absorbedKeys.has(weekendFlowKey(event)));

    if (events.length) {
      cell.classList.add('event_weekend');
      // Hard cap on how many notes one weekend cell will render
      // individually - see WEEKEND_MAX_NOTES. Belt-and-braces alongside
      // the absorption fix in applyWeekendFlow(): that stops the
      // duplicate that caused the reported breakage, this stops ANY busy
      // weekend from setting the height of a whole location row, whatever
      // the cause.
      events.slice(0, WEEKEND_MAX_NOTES).forEach((event) => {
        cell.appendChild(buildWeekendEventNote(event));
      });
      const overflow = events.length - WEEKEND_MAX_NOTES;
      if (overflow > 0) {
        const more = document.createElement('div');
        more.className = 'libcal-gantt__weekend-more';
        more.textContent = Drupal.t('+@count more', { '@count': overflow });
        // The full list has nowhere to go in an 88px column, so it goes
        // in the tooltip; the mobile agenda's weekend divider still
        // lists every occurrence in full.
        more.title = events.slice(WEEKEND_MAX_NOTES).map((event) => event.title).join('\n');
        cell.appendChild(more);
      }
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
    const allDay = isAllDayLabel(event.startLabel, event.endLabel);
    note.title = event.title + ' — ' + (allDay ? Drupal.t('All day') : event.startLabel + '–' + event.endLabel) + (event.location ? ' — ' + event.location : '');

    const dayAbbrev = formatDayLabel(event.day, false).split(',')[0];

    const time = document.createElement('span');
    time.className = 'libcal-gantt__weekend-event-time';
    // The day abbreviation alone already says which day this note is for
    // - an all-day event's time range would just repeat "12:00 AM-11:59
    // PM" next to it for no added information, so it's dropped here
    // rather than replaced with "All day" the way a bar's own time slot
    // is (see isAllDayLabel()'s doc).
    time.textContent = allDay ? dayAbbrev : dayAbbrev + ' ' + event.startLabel + '–' + event.endLabel;
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
   * The same "same recurring thing" identity mergeKey() uses (title +
   * location + start/end time), but for comparing a weekday bar against a
   * weekend event note (GanttEventsController's `weekends[].events`,
   * already scoped to one row, so there's no row field to include here).
   * Used by applyWeekendFlow() below.
   */
  function weekendFlowKey(item) {
    return JSON.stringify([item.title, item.location || '', item.startLabel, item.endLabel]);
  }

  /**
   * A recurring display commonly doesn't stop for the weekend even though
   * this module never renders Saturday/Sunday as their own day columns -
   * that's exactly what the weekend accessory column's real-event case
   * already surfaces (see buildWeekendCell()). Previously that column
   * rendered those weekend occurrences as their own small, separately-
   * styled notes even when they were plainly the same title/location/time
   * as the bar ending on the Friday right next to them - reading as two
   * disconnected things rather than one continuous run. This detects that
   * case and extends the Friday bar across the weekend column instead:
   *
   * - If a multi-day merged run (from clipRunsToChunk()'s `spans`) ends on
   *   the real day immediately before a weekend column, and this row's
   *   weekend events include a match for that run's title/location/time,
   *   the run's `gridColSpan` is grown by one to flow across that column
   *   too (mutates `spans` in place).
   * - If no run ends there but an otherwise-solo (unmerged) event on that
   *   day matches instead, it's promoted into its own synthetic one-day-
   *   plus-weekend spanning entry (pushed onto `spans`) so a display that
   *   only ever repeats into a single weekend - not a multi-weekday run -
   *   still flows the same way a real run would.
   *
   * Either way, the matched weekend event's key is recorded in the
   * returned `absorbedByWeekend` map (keyed by the weekend marker object
   * itself, since the same block can contain more than one weekend gap)
   * so buildWeekendCell() can skip re-listing it as a separate note - see
   * that function's doc. `promotedEvents` is the set of original event
   * objects that got the second treatment above, so the day cell's normal
   * event list can exclude them (they're now rendered as a spanning bar
   * instead - see buildGridBlock()).
   *
   * Desktop grid only - the mobile agenda's weekend divider still lists
   * every occurrence as its own line, since a scrolling list has no
   * equivalent notion of two cells "flowing" into each other the way two
   * adjacent grid columns do.
   */
  function applyWeekendFlow(row, plan, spans, consumedByEvent) {
    const absorbedByWeekend = new Map();
    const promotedEvents = new Set();

    plan.forEach((track, idx) => {
      if (track.type !== 'weekend') {
        return;
      }

      const weekend = track.weekend;
      const weekendEvents = (weekend.events && weekend.events[row.label]) || [];
      if (!weekendEvents.length) {
        return;
      }

      const precedingTrack = plan[idx - 1];
      if (!precedingTrack || precedingTrack.type !== 'day') {
        return;
      }

      const weekendKeys = weekendEvents.map(weekendFlowKey);
      const absorbedKeys = new Set();

      spans
        // Two cases, both of which mean "this bar already accounts for
        // the weekend occurrence visually":
        //
        //  1. The bar ENDS on the real day immediately before this
        //     weekend column, and needs growing by one track to flow
        //     across it.
        //  2. The bar already REACHES ACROSS this weekend column,
        //     because `days` skips Saturday and Sunday entirely, so
        //     computeMergedRunsForRow() treats a Friday and the
        //     following Monday as consecutive and merges straight
        //     through the gap. Nothing to grow here - it already spans
        //     the column - but the weekend occurrence still has to be
        //     recorded as absorbed.
        //
        // Case 2 was the bug behind the reported all-day breakage. The
        // filter used to be an exact `=== precedingTrack.col` test, so a
        // month-long all-day event (one LibCal event with a segment on
        // every weekday, merged into one bar that runs from one edge of
        // the block to the other) matched NEITHER case: the bar drew
        // across the weekend column AND buildWeekendCell() separately
        // listed the same event again as a Saturday note and a Sunday
        // note. Those two notes are stacked in the narrowest track in the
        // grid (88px), so a long title wrapped to one word per line, and
        // because a CSS Grid row is as tall as its tallest cell that one
        // duplicated 88px cell stretched the entire location row from
        // ~48px to ~280px - the empty, over-tall row in the screenshot.
        .filter((span) => {
          const lastCol = span.startGridCol + span.gridColSpan - 1;
          return span.startGridCol <= precedingTrack.col && lastCol >= precedingTrack.col;
        })
        .forEach((span) => {
          const runKey = weekendFlowKey(span.run);
          if (weekendKeys.indexOf(runKey) === -1) {
            return;
          }
          const lastCol = span.startGridCol + span.gridColSpan - 1;
          if (lastCol === precedingTrack.col) {
            span.gridColSpan += 1;
          }
          span.flowsWeekend = true;
          absorbedKeys.add(runKey);
        });

      row.events
        .filter((event) => event.segments && event.segments[precedingTrack.day])
        .filter((event) => {
          const consumedDays = consumedByEvent.get(event);
          return !consumedDays || !consumedDays.has(precedingTrack.day);
        })
        .forEach((event) => {
          const eventKey = weekendFlowKey(event);
          if (weekendKeys.indexOf(eventKey) === -1 || absorbedKeys.has(eventKey)) {
            return;
          }
          promotedEvents.add(event);
          spans.push({
            run: {
              title: event.title,
              location: event.location,
              image: event.image,
              startLabel: event.startLabel,
              endLabel: event.endLabel,
              url: event.url,
              days: [precedingTrack.day],
            },
            startGridCol: precedingTrack.col,
            gridColSpan: 2,
            flowsWeekend: true,
          });
          absorbedKeys.add(eventKey);
        });

      if (absorbedKeys.size) {
        absorbedByWeekend.set(weekend, absorbedKeys);
      }
    });

    return { absorbedByWeekend, promotedEvents };
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
  function buildSpanningBar(run, flowsWeekend) {
    const bar = document.createElement(run.url ? 'a' : 'div');
    bar.className = 'libcal-gantt__bar libcal-gantt__bar--spanning';
    if (flowsWeekend) {
      // Purely a theming hook - applyWeekendFlow() already extended this
      // bar's grid-column span across the weekend accessory column, which
      // is what actually makes it flow visually; no default CSS keys off
      // this class.
      bar.classList.add('libcal-gantt__bar--flows-weekend');
    }

    const allDay = isAllDayLabel(run.startLabel, run.endLabel);
    if (allDay) {
      // Same all-day treatment a single-day bar gets - see buildBar().
      bar.classList.add('libcal-gantt__bar--all-day');
    }
    const dateRange = run.days.length > 1
      ? formatDayLabel(run.days[0], false) + ' – ' + formatDayLabel(run.days[run.days.length - 1], false)
      : formatDayLabel(run.days[0], false);
    bar.title = (allDay ? Drupal.t('All day') : run.startLabel + '–' + run.endLabel)
      + ' — ' + dateRange
      + (run.location ? ' — ' + run.location : '')
      + ' — ' + run.title
      + (flowsWeekend ? ' — ' + Drupal.t('continues through the weekend') : '');

    if (run.url) {
      bar.href = run.url;
      bar.target = '_blank';
      bar.rel = 'noopener noreferrer';
    }

    applyBarImage(bar, run.image);

    const time = document.createElement('span');
    time.className = 'libcal-gantt__bar-time';
    time.textContent = allDay ? Drupal.t('All day') : run.startLabel + '–' + run.endLabel;
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
    applyDayStateClasses(cell, day);

    const dateLine = document.createElement('div');
    dateLine.className = 'libcal-gantt__day-header-date';
    dateLine.textContent = formatDayLabel(day, false);
    cell.appendChild(dateLine);

    // Today gets an explicit visible badge as well as the `today_date`
    // class, for the same reason the open/closed dots exist: a colour
    // change alone is not information for a colour-blind or
    // high-contrast-mode visitor, and this is the one column somebody
    // scanning the chart is most likely looking for. `aria-current="date"`
    // is the matching machine-readable signal for a screen reader, which
    // has no access to the styling at all.
    if (dayStatus(day) === 'today') {
      cell.setAttribute('aria-current', 'date');
      const badge = document.createElement('span');
      badge.className = 'libcal-gantt__day-header-today';
      badge.textContent = Drupal.t('Today');
      cell.appendChild(badge);
    }

    return cell;
  }

  /**
   * Stamps a day-keyed element with its state relative to right now -
   * `past_date`, `today_date` or `future_date` - plus a `data-day-status`
   * attribute carrying the same value for anything that would rather
   * read it as data than as a class.
   *
   * Used for the day-header cell AND for every body cell in that same
   * column (see buildGridBlock()/buildSpanRowFillers()), which is what
   * lets gantt-timeline.css paint today's highlight as one continuous
   * vertical band down the table rather than only tinting the header -
   * grid cells are individually-placed elements here, so there is no
   * single "column" element a rule could target instead.
   *
   * Also used on the mobile agenda's per-day sections, so one set of
   * theme overrides covers both views. The classes are deliberately
   * plain and unprefixed, matching `now_open`/`now_closed`.
   */
  function applyDayStateClasses(element, day) {
    const status = dayStatus(day);
    if (status === 'past') {
      element.classList.add('past_date');
    }
    else if (status === 'today') {
      element.classList.add('today_date');
    }
    else {
      element.classList.add('future_date');
    }
    element.dataset.dayStatus = status;
    return status;
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
   * Always shows the day's actual opening time whenever one is known.
   * It used to be suppressed whenever the location was already open at
   * the start of a configured display window, on the theory that there
   * was "nothing to flag," but the user asked to see the real hours
   * unconditionally instead. (That window setting has since been removed
   * from the module altogether - see libcal_gantt_update_10001().)
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
   * day's actual closing time - see appendOpeningCaption() for why the
   * earlier window-relative suppression was removed, and for the
   * future/past tense switch this shares with it ("Closes 5:00 PM"
   * before it happens, "Closed 5:00 PM" once it has).
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
      // past_date / today_date / future_date, the same classes the
      // desktop grid's day cells get, so one set of theme overrides
      // covers both views - see applyDayStateClasses().
      applyDayStateClasses(section, day);

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
    // Same reasoning as buildWeekendEventNote() - the day abbreviation
    // already says which day, so an all-day event's meaningless
    // "12:00 AM-11:59 PM" range is dropped rather than shown.
    time.textContent = isAllDayLabel(event.startLabel, event.endLabel)
      ? dayAbbrev
      : dayAbbrev + ' ' + event.startLabel + '–' + event.endLabel;
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
    time.textContent = isAllDayLabel(event.startLabel, event.endLabel) ? Drupal.t('All day') : event.startLabel + '–' + event.endLabel;
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
    const allDay = isAllDayLabel(event.startLabel, event.endLabel);
    const bar = document.createElement(event.url ? 'a' : 'div');
    bar.className = 'libcal-gantt__bar';
    if (allDay) {
      // Theming hook for the flatter, accent-edged all-day treatment -
      // see .libcal-gantt__bar--all-day in gantt-timeline.css. "All day"
      // is a categorically different commitment to a 45-minute workshop
      // and shouldn't be read as one.
      bar.classList.add('libcal-gantt__bar--all-day');
    }
    bar.title = (allDay ? Drupal.t('All day') : event.startLabel + '–' + event.endLabel)
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
    time.textContent = allDay ? Drupal.t('All day') : event.startLabel + '–' + event.endLabel;
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

  /**
   * A LibCal "Displays"-style event is commonly entered as running the
   * entire day (00:00-23:59-ish) rather than at a specific time, since the
   * display case itself is just always there - LSU's real feed represents
   * this as `startLabel: '12:00 AM'`, `endLabel: '11:59 PM'` (see
   * GanttEventsController::prepareEvent()). Showing that literal time
   * range on every bar/note is redundant noise for something that isn't
   * actually time-scoped - this flags exactly that case so the various
   * event-detail builders below can show "All day" (or nothing extra,
   * where a day abbreviation already carries the point) instead.
   */
  /**
   * Whether an event's start/end labels describe an all-day event rather
   * than a real time slot.
   *
   * `startLabel`/`endLabel` come from GanttEventsController::
   * prepareEvent(), formatted from the event's OVERALL start and end - so
   * for a multi-day event they are the first day's start and the last
   * day's end, not per-day times.
   *
   * LibCal renders an all-day event as midnight to 11:59 PM, which was
   * the only case handled here originally. Two more are accepted now:
   *
   * - `11:59:59 PM`, which some LibCal responses use instead.
   * - `12:00 AM` to `12:00 AM` - a date range entered with no clock
   *   times, where the end lands on the following midnight. This
   *   previously fell through and rendered as a literal
   *   "12:00 AM-12:00 AM" time slot on the bar, which is both wrong and
   *   the widest possible label to try to fit in a day column.
   */
  function isAllDayLabel(startLabel, endLabel) {
    if (startLabel !== '12:00 AM') {
      return false;
    }
    return endLabel === '11:59 PM'
      || endLabel === '11:59:59 PM'
      || endLabel === '12:00 AM';
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
