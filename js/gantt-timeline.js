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
   * Below this precipitation chance the forecast row drops the percentage
   * and just names the condition. A row reading "0% rain" every day teaches
   * people to stop reading the strip, which costs the building hours
   * sitting directly above it.
   *
   * Mirrors WeatherClient::POP_THRESHOLD, which uses the same number to
   * decide whether an onset time is worth computing at all.
   */
  const WEATHER_POP_THRESHOLD = 30;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * How many LibCal category tags one event prints before the rest are
   * collapsed into a "+N" tag (see appendCategoryTags()).
   *
   * Two limits, not one, because the space differs by an order of
   * magnitude: a grid bar can be a fraction of a narrow day column wide,
   * where a second tag already competes with the event title, while a
   * homepage card or an agenda row has a full line to give. Nothing is
   * ever hidden outright - the overflow tag's tooltip names what it
   * stands for, and every view's own `title` attribute lists all of them.
   */
  const CATEGORY_TAGS_IN_BAR = 1;
  const CATEGORY_TAGS_IN_LIST = 3;

  /**
   * WHICH LibCal categories are allowed to render at all.
   *
   * LSU's calendar tags nearly every event "Library Programs", which is
   * true of nearly every event and so tells a visitor nothing while taking
   * a tag's worth of room on every row. Restricted to the categories that
   * actually distinguish one event from another - for now, just Workshop.
   *
   * Compared case-insensitively against the category name with
   * categoryKey(), so "Workshop", "workshop" and "WORKSHOP" all match
   * however the calendar owner typed it.
   *
   * TO SHOW MORE, add their slugs: ['workshop', 'exhibit', 'lecture'].
   * SET TO AN EMPTY ARRAY to show every category LibCal reports, which is
   * the behaviour this feature shipped with.
   *
   * Filtered in eventCategories(), the one place every view reads
   * categories from, so a hidden category is hidden consistently: it does
   * not appear as a tag, is not counted by the "+N" overflow tag, and is
   * not named in any row's hover tooltip. Nothing anywhere reports a tag
   * the visitor cannot see.
   */
  const CATEGORY_ALLOWLIST = ['workshop'];

  /**
   * How many day cards the homepage variant reveals on FIRST RENDER.
   * Three by default: enough to answer "is anything on this week?"
   * without pushing the rest of the homepage below the fold. Overridable
   * per block instance through the block's "Days per reveal" setting -
   * see readOptions().
   *
   * Subsequent reveals are not this number. Each click finishes the
   * current week band instead, so the added cards always form a complete
   * row - see nextHomepageRevealBoundary(). This constant is no longer an
   * increment of any kind: past the first render it survives only as the
   * floor "Show less" collapses back to, which is the same thing as the
   * starting count.
   */
  const HOMEPAGE_DAYS_PER_REVEAL = 3;

  /**
   * How many grid tracks a week band gets ONCE THE VISITOR HAS EXPANDED.
   * Five - one per weekday - so bands of three, four and five cards all
   * present the same card width down the column instead of three
   * different widths stacked on each other.
   *
   * It is deliberately NOT applied to the unexpanded teaser. Forcing five
   * tracks on a first render of three cards leaves two empty tracks
   * painting as gaps, which is the opposite of what the teaser is for:
   * three cards filling the block's width, readable at a glance, no
   * dead space. So the track count is written onto the band container as
   * a custom property - the card count while collapsed, five after the
   * first reveal - and the CSS reads it. See buildHomepage().
   */
  const HOMEPAGE_WEEK_TRACKS = 5;

  // Stable per-instance IDs let the rebuilt controls keep their ARIA
  // relationships across theme switches, filtering, and pagination.
  let chartInstanceSequence = 0;

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

  /**
   * Field separator for the composite keys that decide whether two LibCal
   * occurrences are the same thing (getRenderableEvents(), mergeKey(), the
   * weekend strip). A NUL cannot appear in a LibCal title, row or room
   * name, so no combination of real values can collide by accident. One
   * constant because three keys expressing one idea were previously built
   * three ways - one of them joining on the TEXT "backslash-u-0000"
   * rather than on the character.
   */
  const MERGE_KEY_SEPARATOR = '\u0000';

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
      instanceId: 'libcal-gantt-' + (++chartInstanceSequence),
      // How many of state.days the homepage variant currently reveals,
      // growing by a whole week band per "Show more" click (see
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
      // The tab a visitor has clicked whose data has NOT arrived yet, or
      // null when nothing is in flight. This is what makes a tab switch
      // non-destructive: the currently-loaded days/events stay in
      // state (and on screen, under a busy overlay - see beginBusy())
      // until the new calendar's first page actually lands, at which
      // point applyCalendarSwitch() swaps everything at once. A failed
      // request therefore leaves the visitor looking at the calendar they
      // were already reading instead of an empty block.
      pendingCalendarId: null,
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
      // One forecast per DAY, not per row - every location in the chart is
      // close enough to share one (see GanttEventsController's
      // WEATHER_DAYS). Empty whenever the feature is off, unconfigured,
      // paged past today, or the weather service didn't answer; all four
      // look the same here on purpose, since all four render nothing.
      weather: {},
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
   *
   * Three loading presentations, not two, decided here rather than by the
   * caller:
   *
   *   - A TAB SWITCH (state.pendingCalendarId set - see switchCalendar())
   *     leaves the existing chart in place and covers it with a busy
   *     overlay. It used to take the first-load path below, which emptied
   *     the container down to a one-line "Loading upcoming events…" and
   *     then re-expanded to the new calendar's full height - a page-wide
   *     shrink and jump on every click, and on the homepage that meant
   *     everything below the block moved twice.
   *   - A FIRST LOAD has nothing to keep, so it still swaps the container
   *     for the loading message.
   *   - A "SHOW MORE" page keeps everything and puts its own button into
   *     a loading state.
   */
  function loadPage(container, endpoint, state, isFirstLoad, onLoaded, variant) {
    if (state.loading) {
      return;
    }
    state.loading = true;

    // Captured per call, not read from state inside the callbacks: by the
    // time the response lands, applyCalendarSwitch() has already cleared
    // state.pendingCalendarId, so the handlers below would no longer be
    // able to tell what kind of request they were completing.
    const switchingTo = state.pendingCalendarId;
    const isSwitch = switchingTo !== null && switchingTo !== undefined;

    if (isSwitch) {
      beginBusy(container, state);
    }
    else if (isFirstLoad) {
      container.innerHTML = '';
      const status = buildLiveRegion(state);
      status.textContent = Drupal.t('Loading events.');
      container.appendChild(status);
      container.appendChild(loadingMessage());
    }
    else {
      setMoreButtonState(container, { loading: true, variant: variant });
    }

    const separator = endpoint.indexOf('?') === -1 ? '?' : '&';
    // A switch is always a fresh first page for the new calendar, so it
    // asks for offset 0 - state.days still holds the OUTGOING calendar's
    // days at this point, which would otherwise be sent as this request's
    // offset and skip the new calendar's first page entirely.
    let url = endpoint + separator + 'offset=' + (isSwitch ? 0 : state.days.length);
    const requestedCalendarId = isSwitch ? switchingTo : state.calendarId;
    if (requestedCalendarId) {
      url += '&calendar=' + encodeURIComponent(requestedCalendarId);
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
        // Only now - with a usable response in hand - is the outgoing
        // calendar's data discarded.
        if (isSwitch) {
          applyCalendarSwitch(state, switchingTo);
        }
        mergeData(state, data);
        if (typeof onLoaded === 'function') {
          onLoaded();
        }
        renderChart(container, endpoint, state);
        if (isSwitch) {
          // After renderChart(), which has already replaced the
          // container's children (overlay included) with the new
          // calendar's chart - this just releases the reserved height and
          // the busy flag now that there is real content to size to.
          endBusy(container);
        }
        announceVisibleState(container, state);
      })
      .catch((error) => {
        state.loading = false;
        if (isSwitch) {
          // Nothing was thrown away, so the previous calendar's chart is
          // still on screen and still correct: the overlay lifts, the
          // tabs go back to describing what is actually being shown, and
          // the failure is reported without taking the view down.
          state.pendingCalendarId = null;
          endBusy(container);
          markCalendarTabPressed(container, state.calendarId);
          announceSwitchFailure(container, state);
        }
        else if (isFirstLoad) {
          container.innerHTML = '';
          const status = buildLiveRegion(state);
          status.textContent = Drupal.t('Events are unavailable right now.');
          container.appendChild(status);
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
   * Covers the chart with the busy overlay for the duration of a tab
   * switch, and pins the container to its current height so the page
   * around it does not reflow while the request is in flight.
   *
   * The height pin is the half of this that matters to the rest of the
   * page: the overlay alone would stop the chart from BLANKING, but the
   * moment the new calendar's chart is drawn the block would still resize
   * from whatever the old one measured. min-height (not height) is used so
   * a taller new chart is never clipped - it is a floor held only until
   * endBusy() removes it.
   */
  function beginBusy(container, state) {
    if (container.querySelector('.libcal-gantt-chart__overlay')) {
      return;
    }

    const height = container.offsetHeight;
    if (height) {
      container.style.minHeight = height + 'px';
    }

    container.classList.add('is-busy');
    // Announced by the live region below, not by the overlay itself:
    // aria-busy tells assistive technology the subtree is mid-update, so
    // the overlay's own text would be a second, redundant announcement.
    container.setAttribute('aria-busy', 'true');
    container.appendChild(buildBusyOverlay());

    const status = container.querySelector('.libcal-gantt-chart__status');
    if (status) {
      status.textContent = Drupal.t('Loading events.');
    }

    // The tabs are still visible under a deliberately light scrim, so a
    // stale pressed state would read as "my click did nothing." The
    // clicked tab is marked immediately; the data catches up.
    markCalendarTabPressed(container, state.pendingCalendarId);
    setCalendarTabsBusy(container, true);
  }

  /**
   * Ends the busy state: drops the height floor, the flag and the overlay.
   *
   * Removing the overlay explicitly as well as releasing the height,
   * because the two exits from a switch differ - a successful one has
   * already had its overlay removed wholesale by renderChart()'s
   * container.innerHTML reset, while a failed one still has the old chart
   * (and the overlay on top of it) in the DOM.
   */
  function endBusy(container) {
    container.style.minHeight = '';
    container.classList.remove('is-busy');
    container.removeAttribute('aria-busy');

    const overlay = container.querySelector('.libcal-gantt-chart__overlay');
    if (overlay) {
      overlay.remove();
    }
    setCalendarTabsBusy(container, false);
  }

  /**
   * The scrim + spinner shown over the chart during a tab switch.
   *
   * aria-hidden, and with no focusable content: everything it conveys is
   * already carried by aria-busy on the chart root and by the live
   * region's "Loading events." - a screen reader should not also meet a
   * decorative spinner. The visible label is for sighted visitors on a
   * slow connection, where a bare spinner over a still-readable chart is
   * ambiguous about what exactly is loading.
   */
  function buildBusyOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'libcal-gantt-chart__overlay';
    overlay.setAttribute('aria-hidden', 'true');

    const box = document.createElement('div');
    box.className = 'libcal-gantt-chart__overlay-box';

    const spinner = document.createElement('span');
    spinner.className = 'libcal-gantt-chart__spinner';
    box.appendChild(spinner);

    const label = document.createElement('span');
    label.className = 'libcal-gantt-chart__overlay-label';
    label.textContent = Drupal.t('Loading…');
    box.appendChild(label);

    overlay.appendChild(box);
    return overlay;
  }

  /**
   * Moves the pressed/active state onto one calendar tab in the
   * ALREADY-RENDERED DOM, without rebuilding anything.
   *
   * Needed because a tab switch no longer re-renders on click: the tabs a
   * visitor is looking at were built for the previous calendar, so their
   * pressed state has to be corrected in place - forward when the click
   * is accepted (beginBusy()) and back again if the request then fails.
   */
  function markCalendarTabPressed(container, calendarId) {
    container.querySelectorAll('.libcal-gantt-tabs__tab').forEach((tab) => {
      const isActive = sameCalendarId(tab.dataset.calendarId, calendarId);
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  /**
   * Marks the tabs as unavailable while a switch is in flight.
   *
   * aria-disabled rather than the `disabled` attribute: the pressed tab
   * is usually the element that still has keyboard focus, and disabling a
   * focused button drops focus to the document body - so a keyboard
   * visitor would lose their place in the block every time they changed
   * tabs. switchCalendar()'s own state.loading guard is what actually
   * rejects a second click; this only says so.
   */
  function setCalendarTabsBusy(container, isBusy) {
    container.querySelectorAll('.libcal-gantt-tabs__tab').forEach((tab) => {
      if (isBusy) {
        tab.setAttribute('aria-disabled', 'true');
      }
      else {
        tab.removeAttribute('aria-disabled');
      }
    });
  }

  /**
   * Reports a failed tab switch without disturbing the chart underneath.
   *
   * Both channels are used deliberately: the live region because the
   * click was made by someone who is now waiting for an answer, and a
   * visible note because the chart still shows real, correct data for the
   * OTHER calendar - silently leaving it there would look like the switch
   * had worked and that calendar was simply identical. The note is
   * inserted rather than replacing anything, and the next successful
   * render clears it along with everything else.
   */
  function announceSwitchFailure(container, state) {
    const status = container.querySelector('.libcal-gantt-chart__status');
    if (status) {
      status.textContent = Drupal.t('That calendar could not be loaded. Still showing the previous one.');
    }

    const existing = container.querySelector('.libcal-gantt-chart__notice');
    if (existing) {
      existing.remove();
    }

    const notice = document.createElement('p');
    notice.className = 'libcal-gantt-chart__notice';
    notice.textContent = Drupal.t('That calendar could not be loaded. Still showing the previous one.');

    // Under the tabs when there are tabs (which, for a switch, there
    // always are), so the message sits with the control that caused it.
    const tabs = container.querySelector('.libcal-gantt-tabs');
    const anchor = tabs ? (tabs.closest('.libcal-gantt-toolbar') || tabs) : null;
    if (anchor && anchor.parentNode === container) {
      container.insertBefore(notice, anchor.nextSibling);
    }
    else {
      container.insertBefore(notice, container.firstChild);
    }
  }

  /**
   * Switches to a different configured calendar tab.
   *
   * Unlike "Show more" (which extends the currently-loaded days), this
   * starts the new calendar over from its first page - the day range and
   * its "Show more" progress don't carry over between tabs, matching how
   * switching a browser tab shows a fresh view rather than picking up
   * mid-scroll from wherever the other tab was left.
   *
   * What it does NOT do any more is clear that data up front. It only
   * records the requested calendar in state.pendingCalendarId and starts
   * the fetch; loadPage() covers the existing chart with a busy overlay,
   * and applyCalendarSwitch() does the actual reset once a response has
   * arrived. Clearing eagerly is what made the block collapse to a single
   * line of loading text between two calendars, and it also meant a
   * failed or slow request left nothing on screen at all.
   */
  function switchCalendar(container, endpoint, state, calendarId) {
    if (state.loading || sameCalendarId(calendarId, state.calendarId)) {
      return;
    }
    state.pendingCalendarId = String(calendarId);
    // isFirstLoad is TRUE only when there is genuinely nothing rendered to
    // keep (a switch fired before any data arrived, which the tabs' own
    // render order makes very unlikely). With content on screen the
    // overlay path in loadPage() takes over regardless of this argument.
    loadPage(container, endpoint, state, !state.days.length);
  }

  /**
   * Discards the outgoing calendar's loaded data and promotes the pending
   * tab to the active one. Called from loadPage() at the moment a switch
   * response arrives - never before, so a failed request changes nothing.
   *
   * Building hours are keyed by location row, not by calendar, so
   * `state.hours` would in principle still be valid - it's cleared anyway
   * for a clean, predictable full reset (the very next merge repopulates
   * it immediately either way). `agendaRowFilter` is deliberately NOT
   * reset: a visitor's chosen building is a display preference that
   * should survive a tab switch, unlike the day range.
   */
  function applyCalendarSwitch(state, calendarId) {
    state.calendarId = String(calendarId);
    state.pendingCalendarId = null;
    state.days = [];
    state.events = [];
    state.hours = {};
    state.weekends = [];
    state.weekendHours = {};
    state.weather = {};
    state.agendaVisibleDayCount = null;
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
    // Any non-empty scalar, not just a string. A "calendars" setting whose
    // keys are numeric LibCal IDs arrives as a NUMBER here, which this
    // guard used to drop - leaving state.calendarId null on first paint, so
    // the tab the server actually served was drawn with no selected state
    // at all (see buildCalendarTabs()).
    if ((typeof data.calendar === 'string' || typeof data.calendar === 'number') && String(data.calendar) !== '') {
      // Confirms/records which tab the server actually served - matters
      // on the very first load, when the request omitted ?calendar= and
      // the server picked the default itself; every later request (page
      // 2+, or after switching tabs) already knows and sends it.
      state.calendarId = String(data.calendar);
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

    // Weather is a flat day => summary map, so it merges in one assign
    // rather than per row. Later pages carry no weather at all (the server
    // only forecasts the unpaged window), and an absent key must not wipe
    // what the first page already delivered - so this only ever adds.
    if (data.weather && typeof data.weather === 'object') {
      Object.assign(state.weather, data.weather);
    }
  }

  function renderChart(container, endpoint, state) {
    container.innerHTML = '';

    // Re-applied on every render, not once at init: the periodic
    // LIVE_REFRESH_INTERVAL_MS re-render and every "Show more" rebuild the
    // container's children, and a theme switch re-renders on purpose so
    // the toggle's own label stays truthful - see buildThemeToggle().
    applyTheme(container, state.theme);
    container.appendChild(buildLiveRegion(state));

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

    const renderEvents = getRenderableEvents(state);
    const rows = buildRows(state.rowLabels, renderEvents);
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
    const activeCalendar = (state.calendars || []).find((calendar) => sameCalendarId(calendar.id, state.calendarId));
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
    const legend = state.options.showLegend
      ? buildLegend(state, calendarShowHours, isHomepage)
      : null;

    if (isHomepage) {
      // One responsive renderer, not the grid/agenda pair: the card grid
      // collapses from three columns to one on a phone through CSS alone,
      // so there is no second view to keep in sync and only one "show
      // more" control to reason about.
      // "Show more" is built into the homepage header alongside the
      // "Full calendar" CTA rather than appended here - see
      // buildHomepageHeader().
      container.appendChild(buildHomepage(container, endpoint, state, calendarShowHours, legend));
    }
    else {
      container.appendChild(buildGrid(state.days, rows, scale, calendarShowHours, state));
      container.appendChild(buildAgenda(container, endpoint, state, calendarShowHours));
      // Two separate "show more" controls, like the grid/agenda split
      // above - both always in the DOM, CSS decides which is visible. The
      // desktop one pages by weekday count; the mobile one pages by event
      // count instead, since a day range that is fine on the wide grid can
      // still be a very long phone scroll - see buildMobileMoreButton().
      container.appendChild(buildMoreButton(container, endpoint, state));
      container.appendChild(buildMobileMoreButton(container, endpoint, state));
    }

    // Keep the legend inside a footer band rather than floating below the
    // component. Homepage mode folds it into the live-hours footer; the
    // full-page mode gets the same contained treatment after its controls.
    if (!isHomepage && legend) {
      const footer = document.createElement('div');
      footer.className = 'libcal-gantt-chart__footer';
      footer.appendChild(legend);
      container.appendChild(footer);
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
  function buildHomepage(container, endpoint, state, calendarShowHours, legend) {
    const wrap = document.createElement('section');
    wrap.className = 'libcal-gantt-home';

    wrap.appendChild(buildHomepageHeader(container, endpoint, state));

    // One element per WEEK BAND, stacked: a card grid, then a weekend
    // strip, then the next week's card grid. See the band loop below for
    // why the strip is no longer a member of the grid it follows.
    const bands = document.createElement('div');
    bands.className = 'libcal-gantt-home__bands';
    bands.id = state.instanceId + '-homepage-bands';

    const days = state.days.slice(0, state.homepageVisibleDays);

    // TWO SIZING MODES, and the whole difference between them is the track
    // count handed to the CSS.
    //
    // Collapsed (first render, `homepageDays` cards, three by default) is a
    // TEASER: as many tracks as there are cards, so the cards divide the
    // full width between them and the block stays the compact strip that
    // earns its place at the top of the homepage.
    //
    // Expanded (any state past the first reveal) is a CALENDAR: five fixed
    // weekday tracks, so a four-card band and a five-card band below it
    // line up column for column and every card makes the same decision
    // about whether its weekday name fits.
    //
    // Read from `days.length`, not from the option, so a feed that returns
    // fewer days than configured still fills the width rather than
    // reserving tracks for cards that do not exist.
    const expanded = state.homepageVisibleDays
      > ((state.options && state.options.homepageDays) || HOMEPAGE_DAYS_PER_REVEAL);
    if (!expanded) {
      bands.classList.add('libcal-gantt-home__bands--teaser');
    }
    bands.style.setProperty(
      '--libcal-gantt-band-tracks',
      String(expanded ? HOMEPAGE_WEEK_TRACKS : Math.max(days.length, 1))
    );

    // Same segments-based grouping the agenda uses: a multi-day event
    // contributes one entry per day it covers, so a week-long display
    // shows up on each of the days actually on screen rather than only on
    // the day it started - which for a long-running exhibit is usually
    // some date well before the visitor is looking.
    const displayCalendar = isLibraryDisplaysCalendar(state);
    // A multi-day event is drawn ONCE as a span, not once per day it
    // covers, in both modes - see splitHomepageSpanEvents(). `daily` is
    // empty for Library Displays, where every record is a span.
    const split = splitHomepageSpanEvents(state, days);
    const spanEvents = split.spans;
    // The weekday columns a span covers, so a card left with nothing of
    // its own does not claim "Nothing scheduled" while a bar runs straight
    // through it further down the band.
    const spannedDays = new Set();
    spanEvents.forEach((event) => {
      Object.keys(event.segments || {}).forEach((day) => spannedDays.add(day));
    });
    const eventsByDay = new Map();
    days.forEach((day) => eventsByDay.set(day, []));
    split.daily.forEach((event) => {
      Object.keys(event.segments || {}).forEach((day) => {
        if (eventsByDay.has(day)) {
          eventsByDay.get(day).push({ event: event, segment: event.segments[day] });
        }
      });
    });

    const weekendByAfter = new Map();
    (state.weekends || []).forEach((weekend) => weekendByAfter.set(weekend.after, weekend));

    // A run of consecutive weekdays gets its own grid, and the weekend
    // strip is appended BETWEEN grids rather than as a member of one.
    //
    // This is the fix for the holes that opened up when more days were
    // revealed. The strip spans the full width, so a grid containing one
    // forced its cards onto more than one row, and the leftover tracks on
    // the short row painted as gaps in the divider colour: four cards, a
    // strip, then two cards came out as a 4-and-a-hole row above a
    // 2-and-three-holes row.
    //
    // One grid per week band means every grid holds one row of nothing but
    // cards. Each grid then takes its track count from
    // `--libcal-gantt-band-tracks` above: the card count while the block
    // is still the collapsed teaser, five fixed weekday tracks once it has
    // been expanded, so bands of four, five and three cards all present the
    // same card width instead of three different ones stacked on top of
    // each other.
    // Which displays have already been introduced further up the block,
    // so a second week band can say "continues" instead of repeating the
    // same exhibit as if it were new. See appendHomepageSpans().
    const seenDisplays = new Set();

    let band = null;
    let bandDays = [];
    // THE FIRST BAND'S HEADING IS HIDDEN FROM SIGHT, NOT FROM THE PAGE.
    //
    // It is the one heading nobody asked for: it renders on load, directly
    // under the block's own header, and says "Week of Sep 15" above a row
    // of cards whose first card is already outlined, badged "Today" and
    // marked aria-current. Two labels for one week, and the redundant one
    // is on top - so it reads as a second header stacked on a header and
    // pushes the cards further down the scarcest space on the homepage.
    //
    // Every LATER heading earns its keep, which is why this is not a rule
    // about week headings in general: those appear only after Show more,
    // where they are the separator that tells you the run of cards you were
    // reading has ended and a new week has started. Hiding those would
    // leave a continuous strip of twelve cards with nothing to break it.
    //
    // Kept in the DOM rather than skipped, because it is doing two jobs
    // that have nothing to do with being seen: it is the accessible name of
    // this band's role="group" (aria-labelledby, below - a named group is
    // how a screen reader user can skip a week they do not care about), and
    // it is this block's only h3, so removing it would leave the day cards
    // hanging off the block heading with a level missing from the outline.
    let bandsStarted = 0;
    const startBand = (firstDay) => {
      bandDays = [firstDay];
      const weekHeading = document.createElement('h3');
      weekHeading.className = 'libcal-gantt-home__week-heading';
      if (bandsStarted === 0) {
        weekHeading.classList.add('libcal-gantt-home__week-heading--offscreen');
      }
      bandsStarted += 1;
      weekHeading.id = state.instanceId + '-week-' + firstDay;
      weekHeading.textContent = Drupal.t('Week of @date', {
        '@date': formatDayLabel(firstDay, true),
      });
      bands.appendChild(weekHeading);

      band = document.createElement('div');
      band.className = 'libcal-gantt-home__days';
      band.setAttribute('role', 'group');
      band.setAttribute('aria-labelledby', weekHeading.id);
      bands.appendChild(band);
      return band;
    };

    const marked = new Set(weekendByAfter.keys());

    days.forEach((day, index) => {
      const currentBand = band || startBand(day);
      if (bandDays[bandDays.length - 1] !== day) {
        bandDays.push(day);
      }
      const card = buildHomepageDayCard(
        day, eventsByDay.get(day) || [], state, calendarShowHours,
        displayCalendar || spannedDays.has(day)
      );
      // The card's half of the phone-layout pairing described in
      // appendHomepageBandHours(). Set for every mode and ignored by
      // all but that one media query, which is cheaper than threading the
      // mode down here to decide.
      card.style.setProperty('--libcal-gantt-day-order', String((bandDays.length - 1) * 2 + 1));
      currentBand.appendChild(card);

      if (isBandEnd(days, index, marked) && (displayCalendar || spanEvents.length)) {
        const drawn = appendHomepageSpans(currentBand, bandDays, state, seenDisplays, spanEvents, displayCalendar);
        // The hours only move out of the cards when this band actually
        // grew a span layer to sit above them - `drawn` is that fact, not a
        // prediction of it. An Events band with no multi-day event keeps
        // them in the card, where they already read correctly under that
        // day's list.
        if (calendarShowHours && drawn) {
          appendHomepageBandHours(currentBand);
        }
      }

      // A weekend is not a day column here (the loaded day list skips
      // Saturday and Sunday), so it renders as a full-width strip after
      // the Friday card instead of competing for one of the card slots - a
      // weekend with nothing on and normal hours is worth one quiet line,
      // not a third of the visitor's attention.
      const weekend = weekendByAfter.get(day);
      if (weekend) {
        const strip = buildHomepageWeekendStrip(weekend, state, calendarShowHours);
        if (strip) {
          bands.appendChild(strip);
        }
      }

      // The band closes at the end of a week whether or not a strip was
      // drawn for it. Splitting only on a rendered strip would put two
      // weeks' cards in one row on a quiet weekend with no hours to
      // report, and the reveal is sized in whole weeks - so the row would
      // hold more cards than fit and wrap, which is the shape the holes
      // came from. Left null rather than opened here so a week ending the
      // revealed range does not leave a stray empty row behind it.
      if (isBandEnd(days, index, marked)) {
        band = null;
      }
    });

    // The visible range can end in the middle of a week (the homepage
    // starts with only Tue–Thu). Render that partial band too:
    // appendHomepageSpans() intersects each merged event with the
    // days currently in bandDays, so a display is visible immediately and
    // naturally grows when Show more rerenders the band with more days.
    if ((displayCalendar || spanEvents.length) && band && bandDays.length) {
      const drawn = appendHomepageSpans(band, bandDays, state, seenDisplays, spanEvents, displayCalendar);
      if (calendarShowHours && drawn) {
        appendHomepageBandHours(band);
      }
    }

    wrap.appendChild(bands);

    const reveal = document.createElement('div');
    reveal.className = 'libcal-gantt-home__reveal';
    const less = buildHomepageLessButton(container, endpoint, state);
    if (less) {
      reveal.appendChild(less);
    }
    const more = buildHomepageMoreButton(container, endpoint, state);
    if (more) {
      reveal.appendChild(more);
    }
    if (reveal.childNodes.length) {
      wrap.appendChild(reveal);
    }

    const footer = document.createElement('div');
    footer.className = 'libcal-gantt-home__footer';
    if (calendarShowHours) {
      const status = buildHomepageStatusBar(state);
      if (status) {
        footer.appendChild(status);
      }
    }
    if (legend) {
      footer.appendChild(legend);
    }
    if (footer.childNodes.length) {
      wrap.appendChild(footer);
    }

    return wrap;
  }

  /**
   * The homepage header bar: heading and covered range on the left, the
   * quiet calendar filter directly beneath that range, and one primary
   * Full calendar CTA on the right.
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
      // Long and short forms of the range, swapped by the chart-root
      // container query at the existing 680px step - the width at which
      // every other part of this module already starts economising. Same
      // CSS-decides-it reasoning as the column heads in
      // buildHomepageDayCard().
      const rangeOf = (endpoint) => (days.length === 1
        ? endpoint(days[0])
        : Drupal.t('@from to @to', {
          '@from': endpoint(days[0]),
          '@to': endpoint(days[days.length - 1]),
        }));

      appendRangeForm(range, 'libcal-gantt-home__range-long', rangeOf(formatRangeEndpoint));
      appendRangeForm(range, 'libcal-gantt-home__range-short', rangeOf((day) => formatDayLabel(day, false)));
      headings.appendChild(range);
    }

    header.appendChild(headings);

    const tabs = buildCalendarTabs(container, endpoint, state);
    if (tabs) {
      headings.appendChild(tabs);
    }

    const controls = document.createElement('div');
    controls.className = 'libcal-gantt-home__controls';

    // The reveal controls live below the cards so the header has one clear
    // primary action: the gold Full calendar CTA. See buildHomepage().

    // No theme toggle in this variant, unlike the grid header (see
    // renderChart()). The homepage block is a teaser embedded in a page
    // whose own palette it does not control: flipping this one panel to a
    // light card leaves it fighting the banner it sits on, and a visitor
    // who wants a light calendar is one click from the full one. The
    // "Appearance" setting still chooses this block's fixed theme - only
    // the visitor-facing switch is withheld here.
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
  function buildHomepageDayCard(day, entries, state, calendarShowHours, spanned) {
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
    // Two forms of the same date, one of which a container query on the
    // card hides (see section 13b in the stylesheet). The choice has to be
    // made in CSS rather than decided here, because what runs out is the
    // CARD's width, and that depends on how many columns the grid fits
    // into whatever slot the block was placed in - there is no viewport
    // breakpoint that corresponds to it, and no resize event on the
    // element itself to hang a measurement off.
    //
    // Both forms sit in the DOM. That is safe for assistive tech because
    // the hidden one is hidden with `display: none`, which takes it out of
    // the accessibility tree as well as off the screen - a screen reader
    // announces one date, not both.
    const nameLong = document.createElement('span');
    nameLong.className = 'libcal-gantt-home__day-name-long';
    nameLong.textContent = formatHomepageDayName(day);
    name.appendChild(nameLong);

    const nameShort = document.createElement('span');
    nameShort.className = 'libcal-gantt-home__day-name-short';
    nameShort.textContent = formatDayLabel(day, false);
    name.appendChild(nameShort);

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
    else if (day === tomorrowDateKey()) {
      // Same badge shape, deliberately quieter: outlined and muted rather
      // than filled gold. Two filled gold pills side by side would read as
      // two equally urgent days and cost today its status as the one thing
      // the eye lands on first - the point of the Today badge is that it
      // is the only one.
      //
      // Keyed on the real date, so this simply does not appear when
      // tomorrow is not a card: on a Friday, tomorrow is Saturday, which
      // this variant folds into the weekend strip - and Monday must not be
      // labelled "Tomorrow" just for being the next card along.
      const badge = document.createElement('span');
      badge.className = 'libcal-gantt-home__today-badge libcal-gantt-home__today-badge--tomorrow';
      badge.textContent = Drupal.t('Tomorrow');
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
      sorted.slice(0, 3).forEach((entry) => list.appendChild(buildHomepageItem(entry.event)));
      card.appendChild(list);
      if (sorted.length > 3) {
        card.appendChild(buildHomepageOverflowLink(day, sorted.length - 3, state));
      }
    }
    // `spanned` is per-DAY on purpose: a card with nothing of its own must
    // not claim "Nothing scheduled" while a span runs straight through its
    // column further down the band. It says nothing about where this card's
    // hours belong - that is a band-level question, and answering both with
    // one flag is what doubled the hours row (see appendHomepageBandHours()).
    else if (!spanned) {
      const empty = document.createElement('p');
      empty.className = 'libcal-gantt-home__empty';
      empty.textContent = Drupal.t('Nothing scheduled');
      card.appendChild(empty);
    }

    // Keep opening hours visible on every card. The hours answer a separate
    // question from the event list, including on busy days.
    //
    // ALWAYS ABBREVIATED AND TABULAR, on every card, busy or empty - see
    // buildHomepageHoursLine(). Spelled out, "Main Library 7:00 AM -
    // midnight - Hill Memorial Library 9:00 AM - 5:00 PM" wraps to two
    // lines in a fifth-width card and buries the one real difference
    // across the week (Friday closing early) mid-string.
    //
    // BUILT HERE FOR EVERY CARD, in every mode. A band that goes on to draw
    // a span layer MOVES this strip out to band level so it sits below the
    // spans rather than above them - appendHomepageBandHours() does that
    // once the band knows whether it drew any, which is not known yet here.
    // Deciding it here as well, from a guess at what the span layer will
    // do, is what rendered the hours twice.
    if (calendarShowHours) {
      appendHomepageHoursLine(card, day, state);
    }

    return card;
  }

  /**
   * Draws the band's SPAN LAYER: one item per multi-day thing, placed
   * across the weekday columns it covers instead of copied into each of
   * them.
   *
   * Used by both modes now. Library Displays put every record here (a
   * display is a weekly record, not a daily appointment); normal Events put
   * only their genuinely multi-day events here - a box drive or an exhibit
   * - while single-day events stay in the day cards. See
   * splitHomepageSpanEvents() for how that line is drawn.
   *
   * Returns whether it drew anything, which the caller needs in order to
   * decide whether this band's hours have to move out of the cards: they
   * only do when there is a span layer for them to sit below.
   */
  function appendHomepageSpans(band, bandDays, state, seenDisplays, spanEvents, displayCalendar) {
    const dayIndex = new Map(bandDays.map((day, index) => [day, index + 1]));
    const spans = (spanEvents || []).map((event) => {
      const covered = Object.keys(event.segments || {}).filter((day) => dayIndex.has(day));
      if (!covered.length) {
        return null;
      }
      const first = Math.min.apply(null, covered.map((day) => dayIndex.get(day)));
      const last = Math.max.apply(null, covered.map((day) => dayIndex.get(day)));
      return { event: event, first: first, last: last };
    }).filter(Boolean).sort((a, b) => a.first - b.first || a.last - b.last);

    const laneEnds = [];
    spans.forEach((span) => {
      let lane = laneEnds.findIndex((end) => end < span.first);
      if (lane === -1) {
        lane = laneEnds.length;
      }
      laneEnds[lane] = span.last;
      // The run as the DATA has it, not as this band shows it. A bar
      // clipped by the visible window used to be indistinguishable from a
      // display that genuinely ends on Thursday.
      const runDays = Object.keys(span.event.segments || {}).sort();
      const clippedStart = !!runDays.length && runDays[0] < bandDays[0];
      const clippedEnd = !!runDays.length && runDays[runDays.length - 1] > bandDays[bandDays.length - 1];

      // Identity WITHOUT the week, so the same display recognised in a
      // later band reads as a continuation rather than as news. The
      // merged records are per-week by construction (see
      // getRenderableEvents()), so week two of one exhibit is a different
      // object with the same identity.
      const identity = [span.event.row, span.event.location || '', span.event.title || '']
        .join(MERGE_KEY_SEPARATOR);
      const continued = !!(seenDisplays && seenDisplays.has(identity));
      if (seenDisplays) {
        seenDisplays.add(identity);
      }

      const item = buildHomepageItem(span.event, formatDisplayRange(span.event), 'div');
      item.classList.add('libcal-gantt-home__item--span');
      if (clippedStart) {
        item.classList.add('is-clipped-start');
      }
      if (clippedEnd) {
        item.classList.add('is-clipped-end');
      }
      if (continued) {
        item.classList.add('is-continued');
        const chip = item.querySelector('.libcal-gantt-home__time');
        if (chip) {
          chip.textContent = Drupal.t('Continues');
        }
      }
      // Placement travels as CUSTOM PROPERTIES, not as inline
      // grid-column/grid-row. The band collapses to a single column below
      // 760px (a phone), where a bar addressed to column three has no
      // column to land in and the cards need their own rows back - and an
      // inline coordinate can only be undone with !important. As
      // properties, the container query re-places this layer normally.
      // See the `max-width: 760px` block in the CSS.
      item.style.setProperty('--libcal-gantt-span-from', String(span.first));
      item.style.setProperty('--libcal-gantt-span-span', String(span.last - span.first + 1));
      item.style.setProperty('--libcal-gantt-span-lane', String(lane + 2));
      // The NAME GOES ON THE LINK, where assistive technology reads it -
      // and it is composed from the same facts the bar shows rather than
      // hard-coding "Ongoing" over the top of them. Falls back to the item
      // when there is no link to carry it.
      const nameParts = [span.event.title];
      const place = span.event.location || span.event.row;
      if (place) {
        nameParts.push(place);
      }
      const spanRange = formatDisplayRange(span.event);
      if (spanRange) {
        nameParts.push(spanRange);
      }
      if (span.event.ongoing) {
        nameParts.push(continued ? Drupal.t('continues this week') : Drupal.t('ongoing'));
      }
      const nameTarget = item.querySelector('.libcal-gantt-home__link') || item;
      nameTarget.setAttribute('aria-label', nameParts.join(', '));
      band.appendChild(item);
    });
    // A week with nothing on view has to SAY so. Per-card "Nothing
    // scheduled" is suppressed in Library Displays mode (a display belongs
    // to the week, not to five separate days), which left an empty week
    // looking exactly like the failure mode where the spans had not been
    // drawn yet: four hours lines and silence. One line, once per band.
    //
    // DISPLAYS ONLY. In Events mode an empty span layer is the normal case
    // - most weeks have no multi-day event - and the day cards are already
    // answering the question for themselves, card by card.
    if (!laneEnds.length && displayCalendar) {
      const empty = document.createElement('p');
      empty.className = 'libcal-gantt-home__display-empty';
      empty.textContent = Drupal.t('No displays on view this week.');
      empty.style.setProperty('--libcal-gantt-span-from', '1');
      empty.style.setProperty('--libcal-gantt-span-lane', '2');
      band.appendChild(empty);
      // The notice is itself placed in a lane, so the band still needs the
      // span grid to put it anywhere sensible.
      markBandAsSpanLayer(band, 1);
      return true;
    }

    if (!laneEnds.length) {
      // Nothing drawn and nothing to say: leave the band as a plain card
      // row, hours included. An Events band that reserved lane rows it
      // never filled would leave a gap under the cards and would have
      // moved the hours strip out for no reason.
      return false;
    }

    markBandAsSpanLayer(band, laneEnds.length);
    return true;
  }

  /**
   * Switches a band over to the span grid: cards pinned to row one, a row
   * per lane below them, and a trailing row for the hours.
   *
   * The class name still says "display-spans" although Events bands now use
   * it too. It is part of the theming surface a site may already have
   * overrides against, and renaming it would break those silently for a
   * cosmetic gain - what it means is "this band has a span layer".
   */
  function markBandAsSpanLayer(band, lanes) {
    band.classList.add('libcal-gantt-home__days--display-spans');
    band.style.setProperty('--libcal-gantt-display-lanes', String(Math.max(lanes, 1)));
  }

  function buildHomepageOverflowLink(day, count, state) {
    const link = document.createElement(state.options.fullCalendarUrl ? 'a' : 'span');
    link.className = 'libcal-gantt-home__overflow';
    link.textContent = Drupal.t('+@count more', { '@count': count });
    if (state.options.fullCalendarUrl) {
      link.href = state.options.fullCalendarUrl;
      link.setAttribute('aria-label', Drupal.t('Show @count more events for @date in the full calendar', {
        '@count': count,
        '@date': formatDayLabel(day, true),
      }));
    }
    return link;
  }

  /**
   * The hours strip for one day, as an element, or null when no row in the
   * band reports hours for it.
   *
   * THE ONLY PLACE A DAY'S HOURS STRIP IS BUILT, for either of the two
   * places it can end up: inside the day card, or re-parented into the band
   * below a span layer by appendHomepageBandHours(). It used to be built
   * from both, with each caller deciding for itself whether the strip
   * belonged to it - and the two decisions disagreed, which is where the
   * doubled hours row came from (see appendHomepageBandHours()).
   */
  function buildHomepageHoursLine(day, state) {
    const rows = [];
    (state.rowLabels || []).forEach((rowLabel) => {
      const rowHours = state.hours && state.hours[rowLabel];
      const entry = rowHours && rowHours[day];
      // ALWAYS THE COMPACT FORM - "Main", "7 AM-midnight" - never the
      // spelled-out "Main Library", "7:00 AM - 8:00 PM". This used to
      // depend on whether the card had any events, on the reasoning that a
      // card with nothing else in it had room for the long form. It does
      // have the room, but taking it cost the thing the strip is actually
      // for: read down the week, these are a COLUMN of times, and a column
      // only reads as one when every cell is the same shape. One card
      // spelling its hours out made the quiet day look like a different
      // kind of row, and it was the widest cell in the band, so it also
      // decided how much room the times got everywhere else.
      const summary = compactHoursSummary(entry);
      if (summary) {
        rows.push({
          label: abbreviateRowLabel(rowLabel),
          // Carried through so the CSS can tint the label with the same
          // family the event tags use for this location. Read here rather
          // than from the abbreviated label, which throws away the words
          // venueKey() matches on.
          key: venueKey(rowLabel),
          summary: summary,
        });
      }
    });
    // The forecast is built BEFORE the early return, so a day whose hours
    // feed came back empty still gets its strip if there's weather to put
    // in it - and a day with neither still gets no strip at all.
    const weatherRow = buildHomepageWeatherRow(day, state);
    if (!rows.length && !weatherRow) {
      return null;
    }
    const line = document.createElement('footer');
    line.className = 'libcal-gantt-home__day-hours';
    // A row per location rather than one joined string. The join used to be
    // ' · ', which read as the divider between locations AND as the space
    // inside each name-and-hours pair; the pair is now the row, so nothing
    // has to stand in for that distinction.
    rows.forEach((row) => {
      const wrap = document.createElement('div');
      wrap.className = 'libcal-gantt-home__hours-row';

      const venue = document.createElement('span');
      venue.className = 'libcal-gantt-home__hours-venue '
        + 'libcal-gantt-home__hours-venue--' + row.key;
      venue.textContent = row.label;

      const time = document.createElement('span');
      time.className = 'libcal-gantt-home__hours-time';
      time.textContent = row.summary;

      wrap.appendChild(venue);
      wrap.appendChild(time);
      line.appendChild(wrap);
    });
    // ONE MORE ROW IN THIS STRIP, not a band of its own. The forecast
    // belongs to the same question the hours answer - what is this day
    // like - and read down the week it has to be a column like they are,
    // which only works if it sits at the same place in every card. Its
    // separator rule is CSS's job, not a class set here: the dotted line
    // above it is drawn by an adjacent-sibling selector, so it appears only
    // when there are hours rows above it to be separated from.
    if (weatherRow) {
      line.appendChild(weatherRow);
    }
    return line;
  }

  /**
   * Builds one day's forecast row: condition on the left, temperatures
   * pushed to the right edge, matching the venue/hours rows above it.
   *
   * Returns null - drawing nothing at all - whenever there is no summary
   * for the day. A silent absence is the intended failure mode for every
   * reason there might not be one (feature off, no coordinate configured,
   * a day too far out to forecast, the weather service down), because a
   * placeholder here would be a claim about the weather.
   */
  function buildHomepageWeatherRow(day, state) {
    const entry = state.weather && state.weather[day];
    if (!entry) {
      return null;
    }

    const summary = describeWeather(entry);
    const hasHigh = typeof entry.high === 'number';
    const hasLow = typeof entry.low === 'number';
    if (!summary && !hasHigh && !hasLow) {
      return null;
    }

    const row = document.createElement('div');
    row.className = 'libcal-gantt-home__day-weather';

    const left = document.createElement('span');
    left.className = 'libcal-gantt-home__weather-summary';
    const icon = buildWeatherIcon(entry.icon);
    if (icon) {
      left.appendChild(icon);
    }
    if (summary) {
      const text = document.createElement('span');
      text.className = 'libcal-gantt-home__weather-cond';
      text.textContent = summary;
      left.appendChild(text);
    }
    row.appendChild(left);

    if (hasHigh || hasLow) {
      const temps = document.createElement('span');
      temps.className = 'libcal-gantt-home__weather-temp';
      // The high carries full strength and the low is held back, because
      // the high is the number anyone actually uses. Both are plain text in
      // one element - no separate spans to align, since these ride the same
      // tabular-nums column the hours use.
      if (hasHigh) {
        const high = document.createElement('span');
        high.className = 'libcal-gantt-home__weather-high';
        high.textContent = formatTemperature(entry.high);
        temps.appendChild(high);
      }
      if (hasLow) {
        const low = document.createElement('span');
        low.className = 'libcal-gantt-home__weather-low';
        // The slash belongs to the pair, so it only exists when there are
        // two numbers - after about 6 PM the weather service stops
        // publishing today's high and this reads "61\u00b0" alone.
        low.textContent = (hasHigh ? '/' : '') + formatTemperature(entry.low);
        temps.appendChild(low);
      }
      row.appendChild(temps);
    }

    return row;
  }

  /**
   * Turns a forecast summary into the one short line the strip has room
   * for, precipitation first.
   *
   * Precipitation is what changes a decision - whether to walk over, and
   * whether an outdoor table happens - so it outranks the condition text
   * whenever it is high enough to mention. Below the threshold the
   * percentage is dropped entirely rather than printed as a reassuring 10%,
   * and the weather service's own words are used instead.
   *
   * "From ~3 PM" is only ever built from a start hour the server chose to
   * send; it withholds one past tomorrow, and for a day that is wet
   * throughout rather than from a point in it (see WeatherClient::onset()).
   * This function never infers a time.
   */
  function describeWeather(entry) {
    const pop = typeof entry.pop === 'number' ? Math.round(entry.pop) : null;
    const condition = String(entry.condition || '');

    if (pop === null || pop < WEATHER_POP_THRESHOLD) {
      return condition;
    }

    // Only rain and thunderstorms get the spelled-out phrasing. Anything
    // else keeps the weather service's own condition text beside the
    // number rather than having a noun invented for it here.
    const isRain = entry.icon === 'rain' || entry.icon === 'storm';
    if (!isRain) {
      return condition
        ? Drupal.t('@pop% @condition', { '@pop': pop, '@condition': condition.toLowerCase() })
        : Drupal.t('@pop% chance of precipitation', { '@pop': pop });
    }

    if (typeof entry.startHour === 'number') {
      return Drupal.t('@pop% rain from ~@time', {
        '@pop': pop,
        // The same formatter the hours row uses, so "3 PM" here and "7 AM"
        // above are the same shape.
        '@time': formatCompactHourFraction(entry.startHour),
      });
    }
    if (entry.sustained) {
      return Drupal.t('@pop% rain most of the day', { '@pop': pop });
    }

    return Drupal.t('@pop% chance of rain', { '@pop': pop });
  }

  function formatTemperature(value) {
    return Math.round(value) + '\u00b0';
  }

  /**
   * Condition icons, as path data keyed by the buckets
   * WeatherClient::iconKey() sorts the forecast text into.
   *
   * Inline SVG rather than an emoji glyph: an emoji ignores the theme's
   * colour tokens, renders differently on every platform, and is announced
   * awkwardly by screen readers. These inherit currentColor and are
   * aria-hidden - the sentence beside them carries the meaning, so nothing
   * here is the only way to learn anything.
   */
  const WEATHER_ICON_PATHS = {
    sun: [
      'M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z',
      'M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5',
    ],
    part: [
      'M9.4 7.6a3.4 3.4 0 0 1 4.6 4',
      'M9.4 2.9v1.7M3.9 8.4h1.7M5.5 4.5l1.2 1.2',
      'M8 19.4h8.1a3.3 3.3 0 0 0 .3-6.6A5.2 5.2 0 0 0 6.8 11.4 3.9 3.9 0 0 0 8 19.4z',
    ],
    cloud: [
      'M8 18.6h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 10.6 3.9 3.9 0 0 0 8 18.6z',
    ],
    rain: [
      'M8 15.2h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 7.2 3.9 3.9 0 0 0 8 15.2z',
      'M8.6 18.1l-.8 2.4M12 18.1l-.8 2.4M15.4 18.1l-.8 2.4',
    ],
    storm: [
      'M8 14.4h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 6.4 3.9 3.9 0 0 0 8 14.4z',
      'M12.9 16.4l-2.6 3.4h2.3l-1.3 2.6',
    ],
    snow: [
      'M8 14.6h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 6.6 3.9 3.9 0 0 0 8 14.6z',
      'M9.2 17.4v3.2M7.8 18.2l2.8 1.6M10.6 18.2l-2.8 1.6',
      'M14.8 17.4v3.2M13.4 18.2l2.8 1.6M16.2 18.2l-2.8 1.6',
    ],
    fog: [
      'M8 13.6h8.1a3.4 3.4 0 0 0 .3-6.7A5.3 5.3 0 0 0 6.7 5.6 3.9 3.9 0 0 0 8 13.6z',
      'M5.6 17.4h12.8M7.6 20.6h8.8',
    ],
  };

  /**
   * Draws one condition icon, or nothing.
   *
   * An unrecognised key returns null rather than falling back to a default
   * glyph: no icon is honest, a wrong icon is a small lie about the
   * weather, and the text beside it is unaffected either way.
   */
  function buildWeatherIcon(key) {
    const paths = WEATHER_ICON_PATHS[String(key || '')];
    if (!paths) {
      return null;
    }

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'libcal-gantt-home__weather-icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    // Decorative twice over: aria-hidden keeps it out of the accessibility
    // tree and focusable=false keeps IE/Edge's old SVG behaviour from
    // putting it in the tab order.
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    paths.forEach((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });

    return svg;
  }

  function appendHomepageHoursLine(card, day, state) {
    const line = buildHomepageHoursLine(day, state);
    if (line) {
      card.appendChild(line);
    }
  }

  /**
   * MOVES each day's hours strip out of its card and into the band, below a
   * span layer the band has just drawn.
   *
   * Why this exists. In a band with no spans the hours are the last thing
   * in the card, under that day's event list, which is the order the
   * information wants: what's on, then when the building is open. A span is
   * not in a card at all - it is a grid item in its own lane below the
   * whole card row (see appendHomepageSpans()) - so leaving the hours in
   * the cards puts them ABOVE every span the band drew, inverting that
   * order for exactly the rows that cross the most days.
   *
   * So when a span layer exists the strip becomes a band-level grid item
   * instead, addressed to its own weekday column and to the row the
   * stylesheet reserves after the lanes. Placement travels as a custom
   * property for the same reason the spans' does - the phone layout
   * collapses the band to one column and re-places this whole layer, which
   * an inline grid coordinate could only override with !important.
   *
   * MOVED, NOT REBUILT, and that is the whole point. This used to build a
   * second set of strips from bandDays while the cards decided separately
   * whether to keep their own, on a test that was not the same test: a card
   * dropped its hours when THAT DAY was spanned, but this ran for EVERY day
   * in the band as soon as the band drew one span. A week where a span
   * covered only some of the days therefore rendered its hours twice - once
   * in the cards that were not spanned, once here for all five - which is
   * the doubled hours row under a merged event. Re-parenting the strip the
   * card already built makes the two placements one placement: there is a
   * single strip per day and it is either in the card or in the band.
   *
   * A day no row reports hours for has no strip to move; because every cell
   * names its own column, the days that do have hours stay under their own
   * card rather than sliding left into the gap.
   */
  function appendHomepageBandHours(band) {
    // The band's cards in document order, which is weekday-column order -
    // the index each strip needs to name its own column. Read from the DOM
    // rather than from bandDays so a day whose card was never appended
    // cannot shift the columns of the days after it.
    const cards = [];
    Array.prototype.forEach.call(band.children, (child) => {
      if (child.classList && child.classList.contains('libcal-gantt-home__day')) {
        cards.push(child);
      }
    });
    cards.forEach((card, index) => {
      let line = null;
      Array.prototype.forEach.call(card.children, (child) => {
        if (!line && child.classList
          && child.classList.contains('libcal-gantt-home__day-hours')) {
          line = child;
        }
      });
      if (!line) {
        return;
      }
      line.classList.add('libcal-gantt-home__day-hours--lane');
      line.style.setProperty('--libcal-gantt-span-from', String(index + 1));
      // Pairs the strip with its card for the single-column phone layout,
      // where these are auto-placed siblings appended after every card
      // rather than addressed cells - without an order they would all
      // collect at the foot of the band, five hours strips in a row
      // detached from the five days they describe. Cards take the odd
      // numbers, so each strip follows its own day (see the 760px block).
      line.style.setProperty('--libcal-gantt-day-order', String(index * 2 + 2));
      band.appendChild(line);
    });
  }

  /**
   * One event inside a day card: time (or an "Ongoing" chip), title, then
   * location. Title before location here, unlike the desktop bar - a card
   * gives the title room to be read as a heading, so it leads, with the
   * room as its subtitle.
   */
  function buildHomepageItem(event, rangeText, tagName) {
    const allDay = isAllDayLabel(event.startLabel, event.endLabel);

    // `li` inside a day card's <ul>, `div` when the display-span layer
    // places it straight into the band grid. An <li> whose parent is a
    // <div role="group"> is invalid markup, loses its list semantics and
    // paints its own bullet - the stray dot beside a spanning display.
    const item = document.createElement(tagName || 'li');
    item.className = 'libcal-gantt-home__item' + (allDay ? ' libcal-gantt-home__item--all-day' : '');

    const link = document.createElement(event.url ? 'a' : 'div');
    link.className = 'libcal-gantt-home__link';
    if (event.url) {
      link.href = event.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    applyItemImage(link, event.image);

    const time = document.createElement('span');
    time.className = 'libcal-gantt-home__time';
    if (allDay || event.ongoing) {
      // "Ongoing" rather than "All day": the events that hit this branch
      // are overwhelmingly exhibits, displays and donation drives that run
      // for weeks, and "All day" invites the reading that they end at
      // midnight tonight.
      time.classList.add('libcal-gantt-home__time--chip');
      time.textContent = Drupal.t('Ongoing');
    }
    else {
      time.textContent = formatCompactTimeRange(event.startLabel, event.endLabel);
    }
    link.appendChild(time);

    const body = document.createElement('span');
    body.className = 'libcal-gantt-home__body';

    const title = document.createElement('span');
    title.className = 'libcal-gantt-home__item-title';
    title.textContent = event.title;
    body.appendChild(title);

    // Falls back to the event's row label ("Main Library", or whatever the
    // online row is called) when LibCal gives no specific room - usually
    // the case for online events, which have no physical location field to
    // fill in.
    //
    // Split into a venue TAG plus plain room text rather than one run of
    // muted grey. The grid variant answers "where is this?" structurally,
    // with a labelled lane per location; this variant has no lanes - three
    // date columns, every location mixed together inside each - so the
    // venue has to carry that job typographically or it does not get done.
    // The tag is the part a visitor scans for ("can I attend this from my
    // desk, or do I have to walk to Hill?"); the room number only matters
    // once they have decided to go, so it stays quiet beside it.
    const locationText = event.isOnline ? Drupal.t('Online') : (event.location || event.row || '');
    // Category tags share that line rather than starting a new one: the
    // card is a fixed-height slot in a row of five, and "where" plus
    // "what kind" are one glance's worth of the same question. The line
    // already wraps (see .libcal-gantt-home__item-location), so a long
    // venue plus two tags drops the tags to a second line instead of
    // overflowing the card.
    const categories = eventCategories(event);
    if (locationText || categories.length) {
      const location = document.createElement('span');
      location.className = 'libcal-gantt-home__item-location';

      if (locationText) {
        // LibCal returns these pre-joined as "Main Library: Lobby", so the
        // first colon is the venue/room seam. No colon means the whole
        // string is the venue ("Online Event") and there is no room to show.
        const seam = locationText.indexOf(':');
        const venueText = (seam === -1 ? locationText : locationText.slice(0, seam)).trim();
        const roomText = seam === -1 ? '' : locationText.slice(seam + 1).trim();

        const venue = document.createElement('span');
        venue.className = 'libcal-gantt-home__venue';
        venue.setAttribute('data-venue', venueKey(venueText));
        venue.textContent = venueText;
        location.appendChild(venue);

        if (roomText) {
          const room = document.createElement('span');
          room.className = 'libcal-gantt-home__room';
          room.textContent = roomText;
          location.appendChild(room);
        }
      }

      if (categories.length) {
        appendCategoryTags(location, categories, 'libcal-gantt-home__tag', CATEGORY_TAGS_IN_LIST);
      }

      body.appendChild(location);
    }

    // Only the merged display layer passes a range. A card item is one
    // day's item and its date is the card it sits in; a display's date is
    // the one fact the block could not otherwise state - how long a
    // visitor has left to see it.
    if (rangeText) {
      const range = document.createElement('span');
      range.className = 'libcal-gantt-home__item-range';
      range.textContent = rangeText;
      body.appendChild(range);
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
    const mergedWeekend = new Map();
    (state.rowLabels || []).forEach((rowLabel) => {
      const rowEvents = (weekend.events && weekend.events[rowLabel]) || [];
      rowEvents.forEach((event) => {
        // The same duplication the weekday cards had, in the weekend
        // accessory line: a box drive that runs through the weekend arrived
        // as a Saturday occurrence AND a Sunday one, so the strip read
        // "Sat · Donation Bin  Sun · Donation Bin" for one continuous
        // thing. Fold those into a single "Sat-Sun" entry.
        //
        // ALL-DAY ONLY, outside Library Displays mode. An all-day event has
        // no sittings, so two consecutive all-day occurrences of one title
        // in one place are that event continuing. A TIMED pair is the
        // recurrence case - a 2 PM class held Saturday and Sunday - and
        // folding it would hide one of two sessions a visitor chooses
        // between, which is the same line splitHomepageSpanEvents() draws
        // for the weekday columns.
        if (!isLibraryDisplaysCalendar(state)
          && !isAllDayLabel(event.startLabel, event.endLabel)) {
          events.push(event);
          return;
        }
        if (!isLibraryDisplaysCalendar(state)) {
          const weekKey = weekStartKey(event.day);
          const allDayKey = [weekKey, rowLabel, event.location || '', event.title || ''].join(MERGE_KEY_SEPARATOR);
          if (!mergedWeekend.has(allDayKey)) {
            mergedWeekend.set(allDayKey, Object.assign({}, event, { days: [] }));
          }
          const allDayTarget = mergedWeekend.get(allDayKey);
          if (allDayTarget.days.indexOf(event.day) === -1) {
            allDayTarget.days.push(event.day);
          }
          return;
        }
        // Weekend payloads are occurrence-shaped, unlike the weekday
        // `state.events` collection. Fold them by the same week/location
        // identity used by getRenderableEvents(), so a display that also
        // appears on Saturday and Sunday is still one homepage item.
        // A display in a locked building is not weekend content. The row's
        // own weekend hours decide it, so a Saturday-closed Hill Memorial
        // stops advertising a case nobody can reach.
        const rowWeekendHours = state.weekendHours && state.weekendHours[rowLabel];
        const dayHours = rowWeekendHours && rowWeekendHours[event.day];
        if (dayHours && dayHours.closed) {
          return;
        }
        const week = weekStartKey(event.day);
        const key = [week, rowLabel, event.location || '', event.title || ''].join(MERGE_KEY_SEPARATOR);
        if (!mergedWeekend.has(key)) {
          mergedWeekend.set(key, Object.assign({}, event, { days: [] }));
        }
        const target = mergedWeekend.get(key);
        if (target.days.indexOf(event.day) === -1) {
          target.days.push(event.day);
        }
      });
    });
    // Both modes now put folded records here: every display in Library
    // Displays mode, the all-day events above in Events mode.
    mergedWeekend.forEach((event) => events.push(event));

    // The weekend line was the last place in the variant still using the
    // spelled-out flat-run form the weekday cards moved away from: it called
    // hoursSummary() with the RAW row label, so a strip reading "Main
    // Library: Sat Closed · Sun 11:00 AM – midnight" sat directly under a
    // card column reading "MAIN  7 AM–midnight". The same fact in two
    // shapes, which is why the eye could not read down the column. It now
    // uses the same two helpers the day cards use - see
    // buildHomepageHoursLine().
    const hourLines = [];
    if (calendarShowHours) {
      (state.rowLabels || []).forEach((rowLabel) => {
        const rowHours = state.weekendHours && state.weekendHours[rowLabel];
        const satEntry = rowHours && rowHours[weekend.saturday];
        const sunEntry = rowHours && rowHours[weekend.sunday];
        const sat = compactHoursSummary(satEntry);
        const sun = compactHoursSummary(sunEntry);
        if (!sat && !sun) {
          return;
        }
        const days = [];
        if (sat) {
          days.push({
            name: Drupal.t('Sat'),
            summary: sat,
            // Read off the entry rather than by comparing the summary
            // against t('Closed'), which stops being true in any
            // translation.
            closed: !!(satEntry && satEntry.closed),
          });
        }
        if (sun) {
          days.push({
            name: Drupal.t('Sun'),
            summary: sun,
            closed: !!(sunEntry && sunEntry.closed),
          });
        }
        // "Closed all weekend" rather than "Sat Closed · Sun Closed". The
        // repetition was the largest single source of noise in this line:
        // for a building shut both days it printed the least informative
        // token twice, at the same weight as the one real fact in the
        // strip. One phrase instead of two, and nothing is lost.
        const allClosed = days.length > 1 && days.every((entry) => entry.closed);
        hourLines.push({
          label: abbreviateRowLabel(rowLabel),
          // Carried so the CSS can tint this label with the same venue
          // family the day cards and the event tags use, instead of
          // leaving both buildings the same grey. Read from the full
          // label, which is what venueKey() matches on.
          key: venueKey(rowLabel),
          days: allClosed
            ? [{ name: '', summary: Drupal.t('Closed all weekend'), closed: true }]
            : days,
        });
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
      // FROM THE MERGED DAYS, not from event.day. Folding Saturday and
      // Sunday together and then labelling the result with whichever
      // occurrence arrived first told a visitor planning a Sunday visit
      // that a display running all weekend was Saturday-only.
      const coveredDays = Array.isArray(event.days) && event.days.length
        ? event.days.slice().sort()
        : [event.day];
      const abbrevOf = (day) => formatDayLabel(day, false).split(',')[0];
      const dayAbbrev = coveredDays.length > 1
        ? abbrevOf(coveredDays[0]) + '\u2013' + abbrevOf(coveredDays[coveredDays.length - 1])
        : abbrevOf(coveredDays[0]);
      const entry = document.createElement(event.url ? 'a' : 'span');
      entry.className = 'libcal-gantt-home__weekend-event';
      if (event.url) {
        entry.href = event.url;
        entry.target = '_blank';
        entry.rel = 'noopener noreferrer';
      }
      const onlinePrefix = event.isOnline ? Drupal.t('Online') + ' · ' : '';
      entry.textContent = isAllDayLabel(event.startLabel, event.endLabel)
        ? dayAbbrev + ' · ' + onlinePrefix + event.title
        : dayAbbrev + ' ' + event.startLabel + ' · ' + onlinePrefix + event.title;
      detail.appendChild(entry);
    });

    // A GROUP of its own rather than loose siblings of the event entries.
    // The rule between two venues is drawn as a border on the second and
    // later lines, and a border like that can only be trusted not to
    // orphan itself at the start of a wrapped line if the direction it
    // wraps in is known. So the group sets a deterministic direction (a
    // row here, a column on a phone) instead of inheriting the detail
    // container's free-wrapping flow.
    if (hourLines.length) {
      const group = document.createElement('span');
      group.className = 'libcal-gantt-home__weekend-hours-group';
      hourLines.forEach((row) => {
        const line = document.createElement('span');
        line.className = 'libcal-gantt-home__weekend-hours';

        const venue = document.createElement('span');
        venue.className = 'libcal-gantt-home__weekend-hours-venue '
          + 'libcal-gantt-home__weekend-hours-venue--' + row.key;
        venue.textContent = row.label;
        line.appendChild(venue);

        row.days.forEach((entry) => {
          const cell = document.createElement('span');
          cell.className = 'libcal-gantt-home__weekend-hours-day'
            + (entry.closed ? ' is_closed' : '');
          // The collapsed "Closed all weekend" carries no day name, so the
          // element is skipped rather than emitted empty - an empty inline
          // still takes the cell's column gap.
          if (entry.name) {
            const name = document.createElement('span');
            name.className = 'libcal-gantt-home__weekend-hours-day-name';
            name.textContent = entry.name;
            cell.appendChild(name);
          }
          const time = document.createElement('span');
          time.className = 'libcal-gantt-home__weekend-hours-time';
          time.textContent = entry.summary;
          cell.appendChild(time);
          line.appendChild(cell);
        });

        group.appendChild(line);
      });
      detail.appendChild(group);
    }

    strip.appendChild(detail);
    return strip;
  }

  /**
   * The live "open right now" status strip, one pill per location row.
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

      // The building name carries the weight, the state stays quiet beside
      // it. Reversed - name muted, state bold - the strip reads as a list
      // of adjectives you have to trace back to a building.
      const name = document.createElement('span');
      name.className = 'libcal-gantt-home__status-row';
      name.textContent = rowLabel;
      pill.appendChild(name);

      const text = document.createElement('span');
      text.className = 'libcal-gantt-home__status-detail';
      text.textContent = describeRowHours(rowLabel, status, state);
      pill.appendChild(text);

      bar.appendChild(pill);
    });

    return wrote ? bar : null;
  }

  /**
   * The words after a building's name in the status strip: "open until
   * 12 AM", "opens 7 AM tomorrow", "opens 9 AM Monday".
   *
   * "Closed" on its own is a dead end - it answers the question the
   * visitor asked and then abandons them, which is exactly the moment
   * they need the next opening time. So a closed building is asked when it
   * opens next, looking through today's remaining hours first (a visitor
   * at 6 AM is before opening, not after closing) and then forward through
   * every day whose hours have been loaded.
   *
   * Falls back to a bare "closed now" only when the answer genuinely isn't
   * in the loaded data - a building with no upcoming hours, or a feed that
   * stops at today. Guessing "opens tomorrow morning" from nothing would
   * be worse than saying less.
   *
   * @param {string} rowLabel
   *   The location row / building name.
   * @param {string} status
   *   'open' or 'closed', from computeRowOpenStatus().
   * @param {Object} state
   *   Chart state, for its hours and weekendHours maps.
   *
   * @return {string}
   *   Localised phrase to print after the building name.
   */
  function describeRowHours(rowLabel, status, state) {
    const rowHours = (state.hours && state.hours[rowLabel]) || {};
    const today = rowHours[todayDateKey()];

    if (status === 'open') {
      // A row can be open with no closing time recorded - hours entries
      // carry openHour and closeHour independently - and "open until
      // undefined" is worse than not saying.
      return (today && typeof today.closeHour === 'number')
        ? Drupal.t('open until @time', {
          '@time': compactClockLabel(formatHourFraction(today.closeHour)),
        })
        : Drupal.t('open now');
    }

    const next = nextOpening(rowLabel, state);
    if (!next) {
      return Drupal.t('closed now');
    }

    const time = compactClockLabel(formatHourFraction(next.openHour));
    const when = relativeDayWord(next.day);
    return when
      ? Drupal.t('opens @time @when', { '@time': time, '@when': when })
      : Drupal.t('opens @time', { '@time': time });
  }

  /**
   * The next moment a building opens, at or after right now.
   *
   * Reads weekday and weekend hours as one merged timeline. They are
   * stored apart (`state.hours` vs `state.weekendHours`) because the grid
   * variant renders Saturday and Sunday as a single collapsed column
   * rather than two of its weekday columns - but that is a layout
   * distinction, and to a visitor standing outside on a Friday night the
   * next opening is Saturday's. Ignoring the weekend map here would tell
   * them the library opens Monday.
   *
   * @param {string} rowLabel
   *   The location row / building name.
   * @param {Object} state
   *   Chart state, for its hours and weekendHours maps.
   *
   * @return {?Object}
   *   `{ day, openHour }` for the next opening, or null when no loaded day
   *   has one.
   */
  function nextOpening(rowLabel, state) {
    const byDay = Object.assign(
      {},
      (state.hours && state.hours[rowLabel]) || {},
      (state.weekendHours && state.weekendHours[rowLabel]) || {}
    );

    const today = todayDateKey();
    const now = nowHourFraction();
    // Y-m-d keys sort chronologically as plain strings, which is the whole
    // reason this module uses them as its day identity.
    const keys = Object.keys(byDay).filter((key) => key >= today).sort();

    for (let i = 0; i < keys.length; i++) {
      const entry = byDay[keys[i]];
      if (!entry || entry.closed || typeof entry.openHour !== 'number') {
        continue;
      }
      // Today's opening only counts if it hasn't happened yet. Past it and
      // the building is closed for the night, so the answer is a later day.
      if (keys[i] === today && now >= entry.openHour) {
        continue;
      }
      return { day: keys[i], openHour: entry.openHour };
    }

    return null;
  }

  /**
   * How to refer to a day relative to today: '' for today itself (the
   * sentence reads "opens 7 AM", with no date needed), "tomorrow", a bare
   * weekday name inside the coming week, and a dated label beyond it -
   * past six days out "Tuesday" is ambiguous about which Tuesday.
   *
   * @param {string} day
   *   ISO date string.
   *
   * @return {string}
   *   Localised relative day phrase, or '' when the day is today.
   */
  function relativeDayWord(day) {
    const today = todayDateKey();
    if (day === today) {
      return '';
    }

    const from = new Date(today + 'T00:00:00');
    const to = new Date(day + 'T00:00:00');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return formatDayLabel(day, false);
    }

    const offset = Math.round((to.getTime() - from.getTime()) / 86400000);
    if (offset === 1) {
      return Drupal.t('tomorrow');
    }
    if (offset > 1 && offset < 7) {
      try {
        return to.toLocaleDateString(undefined, { weekday: 'long' });
      }
      catch (e) {
        return formatDayLabel(day, false);
      }
    }
    return Drupal.t('on @day', { '@day': formatDayLabel(day, false) });
  }

  /**
   * Appends one form of the header's date range - see the long/short pair
   * built in buildHomepageHeader().
   */
  function appendRangeForm(range, className, span) {
    const form = document.createElement('span');
    form.className = className;
    form.textContent = span;
    range.appendChild(form);
  }

  /**
   * The homepage variant's own "Show more" control, separate from the
   * grid's two - it reveals days DOWNWARD (a further band of cards
   * appended beneath the current ones) rather than paging a horizontal
   * axis.
   *
   * Built into the header controls bar next to the "Full calendar" CTA
   * rather than appended under the cards, and labelled without a count:
   * each reveal finishes a week band, so the number of days added varies
   * from click to click (see nextHomepageRevealBoundary()).
   *
   * Keeps the `libcal-gantt-chart__more--homepage` and
   * `libcal-gantt-chart__more-button` hooks that setMoreButtonState()
   * looks for, so the loading and failed-fetch states still land on this
   * button now that it lives somewhere else.
   *
   * Reveals from already-loaded data when it can and only hits the
   * network when it must, which is why loadMoreHomepageDays() is split out
   * below: after the first page there are usually several more loaded days
   * in state.days than the three on screen, and a fetch to display data
   * the browser is already holding would be a pointless spinner.
   */
  function buildHomepageMoreButton(container, endpoint, state) {
    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-chart__more libcal-gantt-chart__more--homepage libcal-gantt-home__more';

    // Describe the next band before the visitor commits to revealing it.
    // The boundary date is known either way, so a date is always named. The
    // count is only stated once the days are loaded, because past the
    // loaded range a closure could still make the promise wrong - and for
    // the same reason the loaded case names the day it will actually end
    // on, which is the Thursday when that week's Friday is a closure the
    // feed never listed.
    const boundary = nextHomepageRevealBoundary(state);
    const covered = homepageRangeCoversBoundary(state, boundary);
    const revealCount = homepageRevealCount(state, boundary);
    const count = Math.max(revealCount - state.homepageVisibleDays, 1);
    const label = covered
      ? Drupal.t('Show @count more days · through @date', {
        '@count': count,
        '@date': formatDayLabel(state.days[revealCount - 1] || boundary, false),
      })
      : Drupal.t('Show more days · through @date', {
        '@date': formatDayLabel(boundary, false),
      });

    wrap.appendChild(buildHomepageRevealButton({
      label: label,
      chevron: '⌄',
      extraClass: 'libcal-gantt-chart__more-button',
      ariaControls: state.instanceId + '-homepage-bands',
      ariaExpanded: state.homepageVisibleDays > (state.options.homepageDays || HOMEPAGE_DAYS_PER_REVEAL),
      onClick: () => loadMoreHomepageDays(container, endpoint, state),
    }));

    return wrap;
  }

  /**
   * The homepage "Show less" control, or null when there is nothing to
   * collapse.
   *
   * Only exists once "Show more" has actually been used: at the starting
   * count there is no previous state to return to, and a permanently
   * disabled or no-op button in the header would be one more thing to read
   * past in a bar that already holds four controls. It appears and
   * disappears rather than greying out for the same reason.
   *
   * Deliberately NOT given the `libcal-gantt-chart__more-button` hook -
   * setMoreButtonState() finds its button by that class, and collapsing
   * never loads anything, so this button must never be the one that turns
   * into "Loading…" or "Try again".
   */
  function buildHomepageLessButton(container, endpoint, state) {
    if (state.homepageVisibleDays <= (state.options.homepageDays || HOMEPAGE_DAYS_PER_REVEAL)) {
      return null;
    }

    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-chart__more libcal-gantt-home__more libcal-gantt-home__more--less';

    wrap.appendChild(buildHomepageRevealButton({
      label: Drupal.t('Show less'),
      chevron: '⌃',
      extraClass: 'libcal-gantt-home__more-button--less',
      ariaControls: state.instanceId + '-homepage-bands',
      ariaExpanded: true,
      onClick: () => collapseHomepageDays(container, endpoint, state),
    }));

    return wrap;
  }

  /**
   * One pill button with a chevron, shared by "Show more" and "Show less"
   * so the pair cannot drift apart in shape, size or wording style - they
   * sit side by side, where any difference between them reads as meaning
   * something.
   */
  function buildHomepageRevealButton(spec) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'libcal-gantt-home__more-button'
      + (spec.extraClass ? ' ' + spec.extraClass : '');
    button.textContent = spec.label;
    if (spec.ariaControls) {
      button.setAttribute('aria-controls', spec.ariaControls);
      button.setAttribute('aria-expanded', spec.ariaExpanded ? 'true' : 'false');
    }
    button.addEventListener('click', spec.onClick);

    const chevron = document.createElement('span');
    chevron.className = 'libcal-gantt-home__more-arrow';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = spec.chevron;
    button.appendChild(chevron);

    return button;
  }

  /**
   * The DATE the next reveal should run through: the Friday closing the
   * week band the last visible day sits in, or the Friday after that when
   * the last visible day has already reached it.
   *
   * Not a fixed increment. The number of columns the card grid fits is
   * decided by the width of whatever slot the block sits in, so any fixed
   * number is the wrong number at some widths: three more days is a
   * ragged half-row in a five-column block and an over-long stack on a
   * phone. What IS stable at every width is the week - so a reveal
   * finishes the week band it is standing in, and if it is already at a
   * Friday it reveals the next whole week. Starting from three days on a
   * Tuesday that reads: three cards, then Tue-Fri, then a full Mon-Fri,
   * then another, each one a complete band with its own grid and no short
   * row. It is also why the button names no fixed number - the honest
   * count changes on every click.
   *
   * A date, not a count, because a count cannot survive the fetch it
   * triggers. The target used to be found by scanning the loaded days for
   * a band end and falling back to `visible + 3` when it found none - and
   * it found none whenever the loaded page happened to end mid-week, which
   * is most of the time: the feed sends 10 open weekdays from today, so a
   * Thursday visitor's page ends on a Wednesday. The fallback then revealed
   * three days, landing mid-week, and every click after it inherited that
   * misalignment. Starting on a Thursday the second click added Mon-Wed;
   * starting on a Monday the third did.
   *
   * Deriving a boundary date first means the answer does not depend on how
   * much happens to be loaded. The click computes "through Fri Oct 2",
   * fetches if it must, and reveals through that Friday when the data
   * lands - so a fetch can no longer change what the click meant.
   *
   * Built on weekStartKey(), which is what getRenderableEvents(), the
   * weekend strip and the agenda's weekly grouping all use to decide which
   * week a day belongs to, so "one more week" means the same thing to the
   * reveal as it does to everything the reveal draws.
   *
   * @param {object} state
   *   Chart state.
   *
   * @return {string}
   *   Y-m-d key of the last day the next reveal should include.
   */
  function nextHomepageRevealBoundary(state) {
    const days = state.days || [];
    const visible = homepageVisibleCount(state);
    const last = days[visible - 1] || days[days.length - 1] || todayDateKey();

    const bandEnd = weekBandEndKey(last);
    let boundary = bandEnd > last ? bandEnd : shiftDayKey(bandEnd, 7);

    // Skip a band that would reveal nothing. A week the feed omits
    // entirely - closed for the holidays, say - is not something to spend a
    // click on, so step over it to the next week that actually has days.
    // Only decidable within the loaded range; past it, the fetch settles
    // the question and the next click re-runs this.
    for (let guard = 0; guard < 8; guard++) {
      if (!days.length || days[days.length - 1] < boundary) {
        break;
      }
      if (homepageCountThrough(days, boundary) > visible) {
        break;
      }
      boundary = shiftDayKey(boundary, 7);
    }

    return boundary;
  }

  /**
   * Friday of the week the given day belongs to.
   */
  function weekBandEndKey(day) {
    return shiftDayKey(weekStartKey(day), 4);
  }

  /**
   * A day key moved by whole calendar days, stepped in UTC: these keys are
   * calendar squares, and adding days to a midnight-local date can land on
   * the same square twice or skip one across a DST change.
   */
  function shiftDayKey(day, delta) {
    const date = new Date(day + 'T00:00:00Z');
    if (Number.isNaN(date.getTime())) {
      return day;
    }
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
  }

  /**
   * How many of the loaded days fall on or before a boundary date. The
   * days are sorted and hold only dates the feed actually listed, so this
   * is also the reveal count for that boundary - a week whose Friday is a
   * closure the feed skipped simply contributes its open days.
   */
  function homepageCountThrough(days, boundary) {
    let count = 0;
    for (let i = 0; i < days.length; i++) {
      if (days[i] > boundary) {
        break;
      }
      count = i + 1;
    }
    return count;
  }

  /**
   * The reveal count for a boundary, clamped to what is loaded.
   *
   * When the boundary lies past the loaded range the caller is expected to
   * fetch; this still returns at least one more day than is showing so the
   * button describes and performs a real change even if that fetch comes
   * back short.
   */
  function homepageRevealCount(state, boundary) {
    const days = state.days || [];
    const visible = homepageVisibleCount(state);
    return Math.max(
      homepageCountThrough(days, boundary),
      Math.min(visible + 1, days.length)
    );
  }

  /**
   * Whether the loaded days already reach a boundary date, i.e. whether a
   * reveal through it can be satisfied without a fetch.
   */
  function homepageRangeCoversBoundary(state, boundary) {
    const days = state.days || [];
    return days.length > 0 && days[days.length - 1] >= boundary;
  }

  /**
   * How many days are on screen, clamped into the loaded range - state can
   * name a count larger than state.days if a fetch came back short.
   */
  function homepageVisibleCount(state) {
    const days = state.days || [];
    const visible = state.homepageVisibleDays || 0;
    return Math.max(Math.min(visible, days.length), 1);
  }

  /**
   * Whether days[i] is the last day of a week band.
   *
   * Three signals, cheapest last, because the homepage feed only sends open
   * weekdays and any one signal can be missing from a given week:
   *
   * 1. The controller marked it as the day a weekend follows.
   * 2. The next loaded day is not the next calendar day. A gap means
   *    something unrendered sits between them - a weekend, or a closure -
   *    which is exactly where a band should break.
   * 3. It is a Friday. The ordinary case, and the one that still works on
   *    the last loaded day, where there is no following day to compare
   *    against and no weekend record yet.
   */
  function isBandEnd(days, i, marked) {
    if (marked.has(days[i])) {
      return true;
    }

    const day = new Date(days[i] + 'T00:00:00Z');
    if (Number.isNaN(day.getTime())) {
      return false;
    }

    if (i + 1 < days.length) {
      const next = new Date(days[i + 1] + 'T00:00:00Z');
      if (!Number.isNaN(next.getTime())
        && next.getTime() - day.getTime() > 86400000) {
        return true;
      }
    }

    // UTC throughout: these keys are calendar squares, and reading the
    // weekday of a midnight-local date is what shifts by one either side of
    // a DST change.
    return day.getUTCDay() === 5;
  }

  /**
   * Works out how many day cards the next COLLAPSE should leave showing -
   * the mirror of nextHomepageRevealBoundary().
   *
   * Steps back by one week band rather than by a fixed count, for the same
   * reason the reveal steps forward by one: a band is the unit the cards
   * are laid out in, so collapsing by anything else would leave a part-week
   * on screen. Never goes below the configured starting count, so "Show
   * less" walks back exactly the path "Show more" walked forward and stops
   * where the block began.
   *
   * @param {object} state
   *   Chart state.
   *
   * @return {number}
   *   Day count the next collapse should leave visible.
   */
  function previousHomepageRevealTarget(state) {
    const visible = state.homepageVisibleDays;
    const days = state.days || [];
    const floor = (state.options && state.options.homepageDays)
      || HOMEPAGE_DAYS_PER_REVEAL;
    const marked = new Set((state.weekends || []).map((weekend) => weekend.after));

    // From the second-to-last visible day: the last one is where the range
    // currently ends, and if that is itself a band end then collapsing to
    // it would change nothing.
    for (let i = visible - 2; i >= 0; i--) {
      if (isBandEnd(days, i, marked)) {
        return Math.max(i + 1, floor);
      }
    }

    return floor;
  }

  /**
   * Collapses the homepage reveal by one band. Never fetches - it is only
   * ever showing less of what the browser already holds, and the days it
   * hides stay in state.days so re-expanding is instant.
   */
  /**
   * The days currently on screen, whichever view is doing the showing:
   * the homepage band reveal, the mobile agenda's own cutoff, or - when
   * neither has narrowed anything - the whole loaded range.
   */
  function visibleDayKeys(state) {
    const days = state.days || [];
    const limit = state.options && state.options.renderMode === 'homepage'
      ? state.homepageVisibleDays
      : state.agendaVisibleDayCount;
    return typeof limit === 'number' && limit > 0 ? days.slice(0, limit) : days.slice();
  }

  /**
   * What the live region says: THE STATE, not the event. "Showing more
   * days." told a screen-reader user that something happened but not what
   * they were now looking at, and "Calendar updated." was announced
   * identically whether the visitor asked for Events, asked for Library
   * Displays, or only revealed more days - the one switch that changes
   * both the content and its layout.
   *
   * Produces, depending on the mode:
   *   "Library Displays, 2 on view, Tuesday, September 15 to Friday, September 25."
   *   "Library Displays, no displays on view, Tuesday, ... to Friday, ..."
   *   "Events, Tuesday, September 15 to Friday, September 25."
   */
  function describeVisibleState(state) {
    const parts = [];

    const active = (state.calendars || []).find((calendar) => sameCalendarId(calendar.id, state.calendarId));
    if (active && active.label) {
      parts.push(active.label);
    }

    const days = visibleDayKeys(state);

    // In display mode the count is the answer to "is there anything to
    // see?" - and it gives F18's empty week something to report rather
    // than announcing a range with nothing in it.
    if (isLibraryDisplaysCalendar(state)) {
      const visibleSet = new Set(days);
      const seen = new Set();
      getRenderableEvents(state).forEach((event) => {
        const covered = Object.keys(event.segments || {}).some((day) => visibleSet.has(day));
        if (!covered) {
          return;
        }
        seen.add([event.row, event.location || '', event.title || ''].join(MERGE_KEY_SEPARATOR));
      });
      parts.push(seen.size
        ? Drupal.formatPlural(seen.size, '1 on view', '@count on view')
        : Drupal.t('no displays on view'));
    }

    if (days.length) {
      parts.push(days.length === 1
        ? formatRangeEndpoint(days[0])
        : Drupal.t('@from to @to', {
          '@from': formatRangeEndpoint(days[0]),
          '@to': formatRangeEndpoint(days[days.length - 1]),
        }));
    }

    return parts.length ? parts.join(', ') + '.' : Drupal.t('Calendar updated.');
  }

  /**
   * Announces describeVisibleState() into the chart's live region. Called
   * after the render, so it describes what is now on screen rather than
   * what was about to be drawn.
   */
  function announceVisibleState(container, state) {
    const status = container.querySelector('.libcal-gantt-chart__status');
    if (status) {
      status.textContent = describeVisibleState(state);
    }
  }

  function collapseHomepageDays(container, endpoint, state) {
    if (state.loading) {
      return;
    }

    const target = previousHomepageRevealTarget(state);
    if (target === state.homepageVisibleDays) {
      return;
    }

    state.homepageVisibleDays = target;
    renderChart(container, endpoint, state);
    announceVisibleState(container, state);
    // ORDER MATTERS: focus first, then scroll. Restoring focus is what
    // makes the block's own scroll correction necessary to get right -
    // see keepChartInView().
    refocusHomepageReveal(container);
    keepChartInView(container);
  }

  /**
   * After a collapse, put focus on the "Show more" button that has just
   * replaced the "Show less" button the visitor pressed.
   *
   * renderChart() rebuilds the block, so the pressed button is detached
   * from the document mid-click and focus falls to <body> - a keyboard or
   * screen reader user is dropped to the top of the page with no idea
   * where they were, and the very next Tab starts the whole document
   * again. The two buttons occupy the same slot and are the same control
   * in two states, so the replacement is where focus belongs.
   *
   * `preventScroll` is essential rather than tidy: focusing an element
   * scrolls it into view by default, and the button is at the BOTTOM of the
   * block - so the browser would scroll down to it and undo the correction
   * keepChartInView() is about to make. Not every engine honours the
   * option, which is the other reason the scroll correction runs after this
   * and not before.
   */
  function refocusHomepageReveal(container) {
    const buttons = container.querySelectorAll('.libcal-gantt-home__more-button');
    let more = null;
    for (let i = 0; i < buttons.length; i++) {
      if (!buttons[i].classList.contains('libcal-gantt-home__more-button--less')) {
        more = buttons[i];
        break;
      }
    }
    if (more && typeof more.focus === 'function') {
      try {
        more.focus({ preventScroll: true });
      }
      catch (e) {
        // An engine that rejects the options object still gets focus.
        more.focus();
      }
    }
  }

  /**
   * Pulls the page back to the top of the block when collapsing has left it
   * above the viewport.
   *
   * Collapsing removes whole day bands, so the block can lose most of its
   * height in one click while the scroll position stays where it was. The
   * visitor pressed a control inside the calendar and was left looking at
   * whatever follows the calendar, with the calendar itself now entirely
   * above the top of the screen - the collapse appears to have thrown the
   * page somewhere instead of shrinking the block.
   *
   * ONLY WHEN IT IS ACTUALLY OFF THE TOP. If the block's top edge is still
   * on screen the visitor can see what changed, and moving the page anyway
   * would be its own small act of violence - the scroll is a repair, not a
   * behaviour.
   *
   * scrollIntoView() rather than window.scrollTo(), because the block may
   * be inside a scrollable ancestor rather than the document - a themed
   * layout column with its own overflow - and scrollIntoView() scrolls
   * whatever container actually needs scrolling. `scroll-margin-top` on the
   * block (see the stylesheet) keeps a sticky site header from covering the
   * top of it on arrival.
   *
   * Smooth unless the visitor asked for less motion, in which case it
   * jumps - a long smooth scroll is exactly the kind of movement
   * prefers-reduced-motion exists to prevent.
   */
  function keepChartInView(container) {
    if (typeof container.getBoundingClientRect !== 'function'
      || typeof container.scrollIntoView !== 'function') {
      return;
    }

    const top = container.getBoundingClientRect().top;
    if (!(top < 0)) {
      return;
    }

    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    try {
      container.scrollIntoView({
        behavior: reduced ? 'auto' : 'smooth',
        block: 'start',
      });
    }
    catch (e) {
      // Older engines only accept the boolean form.
      container.scrollIntoView(true);
    }
  }

  function loadMoreHomepageDays(container, endpoint, state) {
    if (state.loading) {
      return;
    }

    // Resolve the boundary BEFORE any fetch and close over it, so the
    // click's meaning cannot be rewritten by what the page happens to
    // return. Deciding "reveal three more days" up front was the old bug;
    // deciding "reveal through Fri Oct 2" survives the round trip.
    const boundary = nextHomepageRevealBoundary(state);
    const reveal = () => {
      state.homepageVisibleDays = homepageRevealCount(state, boundary);
    };

    if (homepageRangeCoversBoundary(state, boundary)) {
      reveal();
      renderChart(container, endpoint, state);
      announceVisibleState(container, state);
      return;
    }

    // The boundary is past the loaded range - fetch a page, and raise the
    // reveal count inside onLoaded (before the render that loadPage()
    // triggers) so the newly-arrived days appear already revealed instead
    // of needing a second click.
    loadPage(container, endpoint, state, false, reveal, 'homepage');
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
    const renderedEvents = Array.isArray(state.events) ? state.events : [];
    const hasAllDay = renderedEvents.some((event) => isAllDayLabel(event.startLabel, event.endLabel));
    const hasMultiDay = renderedEvents.some((event) => Object.keys(event.segments || {}).length > 1);
    const hasToday = (state.days || []).some((day) => dayStatus(day) === 'today')
      || (state.weekends || []).some((weekend) =>
        weekend.saturday === todayDateKey() || weekend.sunday === todayDateKey()
      );
    const hasWeekend = !isHomepage && Array.isArray(state.weekends) && state.weekends.length > 0;
    const statuses = (state.rowLabels || [])
      .map((rowLabel) => computeRowOpenStatus(rowLabel, state.hours))
      .filter(Boolean);

    const items = [];
    if (hasAllDay) {
      items.push({ modifier: 'all-day', label: Drupal.t('Ongoing / all day') });
    }
    if (hasToday) {
      items.push({ modifier: 'today', label: Drupal.t('Today') });
    }
    if (hasMultiDay && !isHomepage) {
      items.push({ modifier: 'multi', label: Drupal.t('Runs across several days') });
    }
    if (hasWeekend) {
      items.push({ modifier: 'weekend', label: Drupal.t('Weekend') });
    }
    if (calendarShowHours && statuses.includes('open')) {
      items.push({ modifier: 'open', label: Drupal.t('Open right now') });
    }
    if (calendarShowHours && statuses.includes('closed')) {
      items.push({ modifier: 'closed', label: Drupal.t('Closed') });
    }

    if (!items.length) {
      return null;
    }

    const legend = document.createElement('div');
    legend.className = 'libcal-gantt-legend';
    legend.setAttribute('role', 'list');
    legend.setAttribute('aria-label', Drupal.t('What the colours mean'));

    items.forEach((item) => {
      const entry = document.createElement('span');
      entry.className = 'libcal-gantt-legend__item';
      entry.setAttribute('role', 'listitem');

      const swatch = document.createElement('span');
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
    // role="group" with aria-pressed buttons, NOT role="tablist". There is
    // no tabpanel here and no roving-tabindex arrow-key navigation: this
    // control replaces the whole view's data rather than revealing one of
    // several panels, so the tab pattern promised a keyboard contract the
    // widget never implemented. A pressed toggle describes what it does.
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', Drupal.t('Calendar'));

    // Coerced, and with a fallback: a control that is drawn with nothing
    // selected is worse than one that names the server's own default. The
    // id can arrive as a number in the payload and as a string from a
    // click, and every other reader of it already compares as text - see
    // sameCalendarId().
    //
    // A pending switch wins over the loaded calendar, for the window in
    // which the two disagree: with the chart no longer torn down on click
    // (see switchCalendar()), a re-render can land while a request is
    // still in flight, and the tab the visitor just pressed has to stay
    // pressed through it.
    const selectedId = state.pendingCalendarId !== null && state.pendingCalendarId !== undefined
      ? state.pendingCalendarId
      : state.calendarId;
    const hasActive = state.calendars.some((calendar) => sameCalendarId(calendar.id, selectedId));
    state.calendars.forEach((calendar, index) => {
      const isActive = hasActive
        ? sameCalendarId(calendar.id, selectedId)
        : index === 0;

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'libcal-gantt-tabs__tab' + (isActive ? ' is-active' : '');
      tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      // The id on the element itself, so markCalendarTabPressed() can move
      // the pressed state onto the right tab in already-rendered markup
      // without rebuilding the control or matching on its label text.
      tab.dataset.calendarId = String(calendar.id);
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
  function buildGrid(days, rows, scale, calendarShowHours, state) {
    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt';
    wrap.id = state.instanceId + '-grid';
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
    // Tooltip only, deliberately: this note lives in the 88px weekend
    // accessory track, where a visible tag would take a line of its own
    // away from the title. Same reason the note shows no location text.
    note.title = event.title + ' — ' + (allDay ? Drupal.t('All day') : event.startLabel + '–' + event.endLabel) + (event.location ? ' — ' + event.location : '') + categoryTitleSuffix(event);

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
    return [event.row, event.title, event.location || '', event.startLabel, event.endLabel].join(MERGE_KEY_SEPARATOR);
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
              categories: event.categories,
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
            // Same reasoning as `image` below: every day's copy of a
            // merged run carries the same categories, since the merge key
            // already requires the same title, location and time.
            categories: firstEvent.categories,
            // A recurring display's featured image is the same on every
            // day's copy in practice (same mergeKey() match requires the
            // same title/location/time already), so the first day's is as
            // good as any - see buildBar()'s applyBarImage() for how this
            // is actually rendered.
            image: firstEvent.image,
            startLabel: firstEvent.startLabel,
            endLabel: firstEvent.endLabel,
            url: chosenEvent.url,
            ongoing: firstEvent.ongoing,
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
    if (allDay || run.ongoing) {
      // Same all-day treatment a single-day bar gets - see buildBar().
      bar.classList.add('libcal-gantt__bar--all-day');
    }
    const dateRange = run.days.length > 1
      ? formatDayLabel(run.days[0], false) + ' – ' + formatDayLabel(run.days[run.days.length - 1], false)
      : formatDayLabel(run.days[0], false);
    bar.title = ((allDay || run.ongoing) ? Drupal.t('Ongoing') : run.startLabel + '–' + run.endLabel)
      + ' — ' + dateRange
      + (run.location ? ' — ' + run.location : '')
      + ' — ' + run.title
      + categoryTitleSuffix(run)
      + (flowsWeekend ? ' — ' + Drupal.t('continues through the weekend') : '');

    if (run.url) {
      bar.href = run.url;
      bar.target = '_blank';
      bar.rel = 'noopener noreferrer';
    }

    applyBarImage(bar, run.image);

    const time = document.createElement('span');
    time.className = 'libcal-gantt__bar-time';
    time.textContent = (allDay || run.ongoing) ? Drupal.t('Ongoing') : run.startLabel + '–' + run.endLabel;
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

    // Same tags a single-day bar gets - see buildBar(). A merged run
    // carries its first day's categories (see computeMergedRunsForRow()),
    // which is the same set on every day's copy by construction: the merge
    // key already requires an identical title, location and time of day.
    const tags = buildCategoryTagRow(run, 'libcal-gantt__bar-tags', 'libcal-gantt__bar-tag', CATEGORY_TAGS_IN_BAR);
    if (tags) {
      bar.appendChild(tags);
    }

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
    // getRenderableEvents(), not state.events: a Library Displays feed
    // enters one occurrence per day, and this view used to print every
    // one of them. Phones now get the same one-item-per-display reading
    // the grid and the homepage cards do.
    const displayCalendar = isLibraryDisplaysCalendar(state);
    const events = getRenderableEvents(state);
    const hoursByRow = state.hours;
    const weekendHoursByRow = state.weekendHours;
    const rowLabels = state.rowLabels;

    const wrap = document.createElement('div');
    wrap.className = 'libcal-gantt-agenda';
    wrap.id = state.instanceId + '-agenda';

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

    // A merged display covers a whole week, so it is not a member of any
    // one day's list - it is a heading for the week those days belong to.
    // Collected per week here and printed once, above that week's first
    // day section, rather than repeated down every day it covers.
    const displaysByWeek = new Map();
    events.forEach((event) => {
      if (activeRow && event.row !== activeRow) {
        return;
      }
      if (displayCalendar) {
        const covered = Object.keys(event.segments || {}).filter((day) => eventsByDay.has(day)).sort();
        if (covered.length) {
          const week = weekStartKey(covered[0]);
          if (!displaysByWeek.has(week)) {
            displaysByWeek.set(week, []);
          }
          displaysByWeek.get(week).push(event);
        }
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

    let printedWeek = null;
    days.forEach((day) => {
      // One weekly display group per week band, ahead of that week's
      // first day section - and emitted even when the week has no
      // displays, so "nothing on view" is stated rather than left as
      // silence. Same distinction the homepage band makes.
      if (displayCalendar) {
        const week = weekStartKey(day);
        if (week !== printedWeek) {
          printedWeek = week;
          wrap.appendChild(buildAgendaDisplayGroup(day, displaysByWeek.get(week) || []));
        }
      }

      const section = document.createElement('section');
      section.className = 'libcal-gantt-agenda__day';
      // past_date / today_date / future_date, the same classes the
      // desktop grid's day cells get, so one set of theme overrides
      // covers both views - see applyDayStateClasses().
      applyDayStateClasses(section, day);
      if (day === today) {
        section.setAttribute('aria-current', 'date');
      }

      const title = document.createElement('div');
      title.className = 'libcal-gantt-agenda__day-title';
      title.setAttribute('role', 'heading');
      title.setAttribute('aria-level', '3');
      title.textContent = formatDayLabel(day, true);
      if (day === today) {
        const todayLabel = document.createElement('span');
        todayLabel.className = 'libcal-gantt-agenda__today-label';
        todayLabel.textContent = Drupal.t('Today');
        title.appendChild(todayLabel);
      }
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
        const hasHours = calendarShowHours && visibleRowLabels.some((rowLabel) =>
          hoursSummary(hoursByRow && hoursByRow[rowLabel] && hoursByRow[rowLabel][day])
        );
        if (!hasHours && day !== today) {
          section.classList.add('is-empty');
        }
        // Not in display mode: a display is a property of the week, and
        // the weekly group above has already answered for it. Repeating
        // "No events scheduled" under it five times would contradict it.
        if (!displayCalendar) {
          const empty = document.createElement('p');
          empty.className = 'libcal-gantt-agenda__empty';
          empty.textContent = Drupal.t('No events scheduled.');
          section.appendChild(empty);
        }
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
    announceVisibleState(container, state);
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
    button.setAttribute('aria-controls', state.instanceId + '-agenda');
    button.setAttribute('aria-expanded', state.agendaVisibleDayCount < state.days.length ? 'true' : 'false');
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
  /**
   * "On display" - the agenda's equivalent of the card grid's span layer.
   * One row per merged display with its real date range, or one line
   * stating that the week has none.
   */
  function buildAgendaDisplayGroup(firstDay, displays) {
    const group = document.createElement('section');
    group.className = 'libcal-gantt-agenda__displays';
    group.setAttribute('role', 'group');

    const heading = document.createElement('div');
    heading.className = 'libcal-gantt-agenda__displays-title';
    heading.setAttribute('role', 'heading');
    heading.setAttribute('aria-level', '3');
    heading.textContent = Drupal.t('On display \u00b7 week of @date', {
      '@date': formatDayLabel(firstDay, false),
    });
    group.appendChild(heading);

    if (!displays.length) {
      const empty = document.createElement('p');
      empty.className = 'libcal-gantt-agenda__empty';
      empty.textContent = Drupal.t('No displays on view this week.');
      group.appendChild(empty);
      return group;
    }

    const list = document.createElement('ul');
    list.className = 'libcal-gantt-agenda__list';
    displays
      .slice()
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
      .forEach((event) => list.appendChild(buildAgendaItem(event, formatDisplayRange(event))));
    group.appendChild(list);

    return group;
  }

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
    applyItemImage(link, event.image);

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

    const locationText = event.isOnline ? Drupal.t('Online') : (event.location || event.row || '');
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

    const tags = buildCategoryTagRow(event, 'libcal-gantt-agenda__tags', 'libcal-gantt-agenda__tag', CATEGORY_TAGS_IN_LIST);
    if (tags) {
      details.appendChild(tags);
    }

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
    // Same reasoning as buildCalendarTabs(): a filter, not a tab set.
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', Drupal.t('Filter by building'));

    const options = [{ label: Drupal.t('All buildings'), value: null }].concat(
      state.rowLabels.map((label) => ({ label, value: label }))
    );

    options.forEach((option) => {
      const isActive = state.agendaRowFilter === option.value;

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'libcal-gantt-agenda-filter__tab' + (isActive ? ' is-active' : '');
      tab.setAttribute('aria-pressed', isActive ? 'true' : 'false');
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
        const status = container.querySelector('.libcal-gantt-chart__status');
        if (status) {
          status.textContent = Drupal.t('Showing events for @building.', { '@building': option.label });
        }
      });

      wrap.appendChild(tab);
    });

    return wrap;
  }

  function buildAgendaItem(event, rangeText) {
    const item = document.createElement('li');
    item.className = 'libcal-gantt-agenda__event';

    const link = document.createElement(event.url ? 'a' : 'div');
    link.className = 'libcal-gantt-agenda__link';
    if (event.url) {
      link.href = event.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    applyItemImage(link, event.image);

    const time = document.createElement('span');
    time.className = 'libcal-gantt-agenda__time';
    time.textContent = (isAllDayLabel(event.startLabel, event.endLabel) || event.ongoing) ? Drupal.t('Ongoing') : event.startLabel + '–' + event.endLabel;
    link.appendChild(time);

    const details = document.createElement('span');
    details.className = 'libcal-gantt-agenda__details';

    // Falls back to the event's row (e.g. "Main Library" or whatever the
    // online row is labeled) when there's no specific room/location text
    // - most often true for online events, whose location field is
    // typically blank since a physical room doesn't apply to them.
    // Shown before the title, same order as the desktop bar (see
    // buildBar()).
    const locationText = event.isOnline ? Drupal.t('Online') : (event.location || event.row || '');
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

    // Only merged displays pass a range: for them the run, not the clock,
    // is the fact worth printing.
    if (rangeText) {
      const range = document.createElement('span');
      range.className = 'libcal-gantt-agenda__range';
      range.textContent = rangeText;
      details.appendChild(range);
    }

    // A phone row has a full line to give, so this view prints up to
    // CATEGORY_TAGS_IN_LIST tags rather than the grid bar's one.
    const tags = buildCategoryTagRow(event, 'libcal-gantt-agenda__tags', 'libcal-gantt-agenda__tag', CATEGORY_TAGS_IN_LIST);
    if (tags) {
      details.appendChild(tags);
    }

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
    button.setAttribute('aria-controls', state.instanceId + '-grid');
    button.setAttribute('aria-expanded', state.days.length > (state.pageSize || 10) ? 'true' : 'false');
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
  /** Returns display-mode events merged by actual week, building, location, and title. */
  /**
   * Splits the homepage's events into the ones that belong in the SPAN
   * LAYER - drawn once, across the weekday columns they cover - and the
   * ones that belong in a day card's list.
   *
   * WHY THIS IS NOT THE SAME QUESTION AS mergeKey()'s. There are two
   * distinct ways a title can appear on several days, and only one of them
   * is a multi-day event:
   *
   *  - ONE EVENT THAT SPANS DAYS. A box drive or an exhibit runs from a
   *    start date to an end date, and prepareEvent() gives that single
   *    event a segment per day it touches. It is already one object; the
   *    homepage was simply drawing it once per segment, which is what
   *    produced a "EMPOWERHER Health Donation Bin" card on every day of
   *    the fortnight. These are spans.
   *  - SEPARATE OCCURRENCES THAT REPEAT. A daily workshop at 9 AM is a
   *    different LibCal event each day, each with one segment. Folding
   *    those together is the recurrence merge mergeKey() does for the
   *    desktop grid, and it is deliberately NOT done here - two sittings
   *    of a class are two things a visitor picks between, and the card
   *    list is where they can see both.
   *
   * So the test is simply how many of the VISIBLE WEEKDAY COLUMNS one
   * event's own segments cover. Weekday columns rather than raw segment
   * keys, because prepareEvent() also emits Saturday and Sunday segments
   * for the weekend strip: counting those would promote an ordinary Friday
   * evening event that happens to run past midnight into a one-column
   * "span", which is a worse rendering of it than the card it was in.
   *
   * Library Displays keep their existing behaviour - every merged record is
   * a span, because a display IS the week - see getRenderableEvents().
   */
  function splitHomepageSpanEvents(state, visibleDays) {
    if (isLibraryDisplaysCalendar(state)) {
      return { spans: getRenderableEvents(state), daily: [] };
    }

    const daySet = new Set(visibleDays);
    const spans = [];
    const daily = [];
    getRenderableEvents(state).forEach((event) => {
      let covered = 0;
      Object.keys(event.segments || {}).forEach((day) => {
        if (daySet.has(day)) {
          covered++;
        }
      });
      if (covered > 1) {
        spans.push(event);
      }
      else {
        daily.push(event);
      }
    });
    return { spans: spans, daily: daily };
  }

  function getRenderableEvents(state) {
    if (!isLibraryDisplaysCalendar(state)) {
      return state.events;
    }
    const merged = new Map();
    state.events.forEach((event) => {
      const days = Object.keys(event.segments || {});
      days.forEach((day) => {
        const week = weekStartKey(day);
        // Library Displays are a single weekly/location display, even when
        // LibCal supplies separate occurrences or titles for that same
        // place and week. Normal Events keep their original event objects.
        // IDENTITY INCLUDES THE TITLE. Keyed on week + row + location
        // alone, two unrelated exhibits sharing a case for a week folded
        // into one record whose title was both titles joined with a middle
        // dot, carrying one exhibit's link and the other's dates. The
        // duplicates this merge exists to remove are repeated OCCURRENCES
        // OF THE SAME DISPLAY, so the display's own title is part of what
        // makes it the same display. Two displays in one location stay two
        // records, and the lane packer in appendHomepageSpans() /
        // computeMergedRunsForRow() stacks them. Location stays in the
        // key, so a display that moves rooms mid-week still reads as two
        // placements.
        const key = [week, event.row, event.location || '', event.title || ''].join(MERGE_KEY_SEPARATOR);
        if (!merged.has(key)) {
          merged.set(key, Object.assign({}, event, { segments: {}, ongoing: false }));
        }
        const target = merged.get(key);
        target.segments[day] = event.segments[day];
        if (event.url && !target.url) target.url = event.url;
        if (event.image && !target.image) target.image = event.image;
      });
    });
    merged.forEach((event) => {
      // ONGOING IS A PROPERTY OF THE SPAN, not of a location name. This
      // used to test the row/room text against /hill memorial/i and to
      // require today to fall inside the run, which meant three different
      // things went wrong at once: a Hill display starting next Monday got
      // no chip, a Main Library case whose feed reports 9-5 instead of
      // midnight-to-midnight lost the chip its neighbour kept, and a
      // location string renamed in the settings form silently changed the
      // behaviour with no error. A merged display covering more than one
      // loaded weekday is on view across those days by construction -
      // true of Hill Memorial, true of the lobby cases, and true of the
      // next location added. Tense is carried by the range text beside
      // the chip (see formatDisplayRange()), not by withholding it.
      event.ongoing = Object.keys(event.segments).length > 1;
    });
    return Array.from(merged.values());
  }

  /**
   * Calendar ids compared as text, in one place. The settings form's keys
   * can be numeric LibCal ids (arriving as JSON numbers) or names
   * (arriving as strings), and the same id reaches this file from two
   * directions - the payload and a tab click - so a strict comparison
   * quietly disagreed with itself depending on which arrived last.
   */
  function sameCalendarId(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) {
      return false;
    }
    return String(a) === String(b);
  }

  function isLibraryDisplaysCalendar(state) {
    const active = (state.calendars || []).find((calendar) => sameCalendarId(calendar.id, state.calendarId));
    // The response normally supplies the tab key separately, but accepting
    // the label as a fallback keeps the homepage merge active during the
    // first render and with older endpoint responses that omit `calendar`.
    return !!((active && /library\s+displays/i.test(active.label || ''))
      || /library\s+displays/i.test(String(state.calendarId || '')));
  }

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
      + ' — ' + event.title
      + categoryTitleSuffix(event);

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
    const locationText = event.isOnline ? Drupal.t('Online') : event.location;
    if (locationText) {
      const location = document.createElement('span');
      location.className = 'libcal-gantt__bar-location' + (event.isOnline ? ' libcal-gantt__bar-location--online' : '');
      location.textContent = locationText;
      bar.appendChild(location);
    }

    const label = document.createElement('span');
    label.className = 'libcal-gantt__bar-label';
    label.textContent = event.title;
    bar.appendChild(label);

    // LibCal categories, after the title rather than beside the location:
    // "Workshop" answers "is this for me?", which is a question a reader
    // only asks once they have read what the event is. Capped hard in this
    // view - see CATEGORY_TAGS_IN_BAR.
    const tags = buildCategoryTagRow(event, 'libcal-gantt__bar-tags', 'libcal-gantt__bar-tag', CATEGORY_TAGS_IN_BAR);
    if (tags) {
      bar.appendChild(tags);
    }

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

  /**
   * The same LibCal "Featured image", applied to a LIST ROW rather than a
   * grid bar - the homepage cards' items and the mobile agenda's rows (see
   * buildHomepageItem()/buildAgendaItem()). Does nothing at all for an
   * event without an image, which is the common case, so those rows render
   * exactly the markup they did before this feature existed.
   *
   * A plain `has-image` state class plus ONE shared custom property, not a
   * per-view BEM modifier: the two views paint the image identically (see
   * "Item background images" in gantt-timeline.css) and differ only in the
   * element it lands on, so one class keeps that treatment in a single
   * rule instead of two that have to be kept in step. It is deliberately
   * unprefixed for the same reason the state classes are - a theme may
   * want to switch the effect off for one placement.
   *
   * JSON.stringify() quotes and escapes the URL, so a stray quote or
   * parenthesis in a LibCal filename cannot break out of the url() token -
   * the same protection applyBarImage() relies on above.
   */
  function applyItemImage(element, imageUrl) {
    if (!imageUrl) {
      return;
    }
    element.classList.add('has-image');
    element.style.setProperty('--libcal-gantt-item-image', 'url(' + JSON.stringify(imageUrl) + ')');
  }

  function headerCell(className, text) {
    const cell = document.createElement('div');
    cell.className = className;
    cell.textContent = text;
    return cell;
  }

  /**
   * An event's LibCal categories ("Workshop", "Exhibit", ...), normalised.
   *
   * LibCal lists categories per event as `[{id, name}, ...]` and the
   * endpoint flattens that to a plain array of names (see
   * GanttEventsController::extractCategories()). Re-normalised here anyway,
   * defensively and cheaply, because this file also renders payloads a
   * cached older response can still supply: an event with no `categories`
   * key at all reads as "no tags" rather than throwing, and an object
   * shape that slipped through is read for its `name`.
   *
   * De-duplicated case-insensitively while KEEPING the first spelling
   * LibCal used - "Workshop" and "workshop" are one tag, printed the way
   * the calendar owner typed it first.
   */
  function eventCategories(event) {
    const raw = event && event.categories;
    if (!Array.isArray(raw)) {
      return [];
    }

    const seen = new Set();
    const names = [];
    raw.forEach((entry) => {
      let text = '';
      if (typeof entry === 'string' || typeof entry === 'number') {
        text = String(entry).trim();
      }
      else if (entry && typeof entry === 'object') {
        text = String(entry.name || '').trim();
      }
      const key = text.toLowerCase();
      if (text && !seen.has(key)) {
        seen.add(key);
        // Allowlisted on the SLUG, not the raw name, so the comparison is
        // insensitive to case, spacing and punctuation the same way the
        // data-category theming hook is. See CATEGORY_ALLOWLIST.
        if (!CATEGORY_ALLOWLIST.length
          || CATEGORY_ALLOWLIST.indexOf(categoryKey(text)) !== -1) {
          names.push(text);
        }
      }
    });

    return names;
  }

  /**
   * A theming hook per category, in the spirit of venueKey(): a class-safe
   * slug of the category name, exposed as `data-category` on every tag so
   * a site can colour "Workshop" differently from "Exhibit" without this
   * module having to ship an opinion about either. Unlike venueKey() there
   * is no fixed vocabulary to map onto - LibCal categories are free-form
   * per instance - so the name is slugged rather than classified, and the
   * stylesheet gives every category one neutral treatment by default.
   */
  function categoryKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Appends one tag element per category name to `target`.
   *
   * `limit` caps how many are drawn, with the remainder collapsed into a
   * "+2" tag whose tooltip names them. That matters in the grid, where a
   * bar can be a fifth of a narrow column wide: an event carrying four
   * categories would otherwise push its own title out of view, and the
   * title is the thing being scanned for. Pass 0 for no cap.
   */
  function appendCategoryTags(target, names, tagClass, limit) {
    const shown = (limit > 0 && names.length > limit) ? names.slice(0, limit) : names;

    shown.forEach((name) => {
      const tag = document.createElement('span');
      tag.className = tagClass;
      tag.setAttribute('data-category', categoryKey(name));
      tag.textContent = name;
      target.appendChild(tag);
    });

    if (shown.length < names.length) {
      const rest = names.slice(shown.length);
      const more = document.createElement('span');
      more.className = tagClass + ' ' + tagClass + '--more';
      more.textContent = '+' + rest.length;
      more.title = rest.join(', ');
      target.appendChild(more);
    }
  }

  /**
   * The same tags as a self-contained row element, or null when the event
   * has no categories - so a calendar that uses none renders exactly the
   * markup it did before this feature existed. Used by the views whose
   * layout needs the tags kept on their own line (the grid bar, the mobile
   * agenda); the homepage cards append tags straight into the location
   * line instead, which is already a wrapping flex row.
   */
  function buildCategoryTagRow(event, rowClass, tagClass, limit) {
    const names = eventCategories(event);
    if (!names.length) {
      return null;
    }

    const row = document.createElement('span');
    row.className = rowClass;
    appendCategoryTags(row, names, tagClass, limit);
    return row;
  }

  /**
   * The categories as a " — Workshop, Exhibit" tooltip fragment, or an
   * empty string. Every view that prints a `title` attribute already
   * spells out time, location and title there for the truncated case, so
   * the tags belong in it too - a tag dropped by CATEGORY_TAGS_IN_BAR /
   * CATEGORY_TAGS_IN_LIST, or ellipsised by CSS, is still readable on
   * hover.
   */
  function categoryTitleSuffix(event) {
    const names = eventCategories(event);
    return names.length ? ' — ' + names.join(', ') : '';
  }

  function loadingMessage() {
    const message = document.createElement('p');
    message.className = 'libcal-gantt-chart__loading';
    message.textContent = Drupal.t('Loading upcoming events…');
    return message;
  }

  function buildLiveRegion(state) {
    const region = document.createElement('div');
    region.className = 'libcal-gantt-chart__status';
    region.id = state.instanceId + '-status';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    return region;
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
   * "7 AM", "9:30 AM", "midnight" - the hours line's tabular form.
   *
   * Two things are dropped relative to hoursSummary() and one is not:
   *
   * - `:00` goes. A trailing double zero is the widest, least
   *   informative part of the string, and dropping it is what lets a
   *   column of whole-hour days line up with the one day that opens at
   *   half past reading as the exception.
   * - The meridiem stays, spelled AM/PM. This line previously carried a
   *   single-letter suffix ("7a", "12a"), which saved two characters at
   *   the cost of being a notation the reader has to be taught: "12a" is
   *   the middle of the night, and nothing on the card says so.
   * - Midnight is named rather than clocked, matching
   *   formatHourFraction() and compactClockLabel(). A library open "7 AM
   *   to midnight" is the sentence a visitor would say out loud, and
   *   "12 AM" is the one AM/PM reading people reliably invert.
   *
   * The space before the meridiem is non-breaking: the hours line sets
   * `overflow-wrap: anywhere` to survive a fifth-width card, which would
   * otherwise happily leave "AM" alone on the next line.
   */
  function formatCompactHourFraction(hour) {
    const totalMinutes = Math.round(hour * 60);
    if (totalMinutes % 1440 === 0) {
      return Drupal.t('midnight');
    }
    const h24 = Math.floor(totalMinutes / 60) % 24;
    const minutes = totalMinutes % 60;
    const meridiem = h24 >= 12 ? 'PM' : 'AM';
    let h12 = h24 % 12;
    if (h12 === 0) {
      h12 = 12;
    }
    return h12
      + (minutes ? ':' + String(minutes).padStart(2, '0') : '')
      + '\u00a0' + meridiem;
  }

  /**
   * The compact counterpart to hoursSummary(): "7 AM-midnight",
   * "9 AM-5 PM", "Closed". Same data, same source entry - only the width
   * differs.
   *
   * Unlike formatCompactTimeRange(), a meridiem shared by both ends is
   * printed twice rather than once. That function abbreviates an event's
   * own start and end, read as a pair; this one produces a column read
   * down the week and across two locations, where "1-5 PM" next to
   * "9 AM-5 PM" invites the eye to pair the wrong halves.
   */
  function compactHoursSummary(entry) {
    if (!entry) {
      return null;
    }
    if (entry.closed) {
      return Drupal.t('Closed');
    }
    if (typeof entry.openHour === 'number' && typeof entry.closeHour === 'number') {
      return formatCompactHourFraction(entry.openHour) + '\u2013' + formatCompactHourFraction(entry.closeHour);
    }
    return entry.label || null;
  }

  /**
   * "Main Library" -> "Main", "Hill Memorial Library" -> "Hill". Uses the
   * same venue classification the location badges use (see venueKey()), so
   * the short form of a row label cannot disagree with the badge colour
   * assigned to the same place. Anything unrecognised keeps its first
   * word, which is the part a reader scans anyway.
   */
  function abbreviateRowLabel(rowLabel) {
    const key = venueKey(rowLabel);
    if (key === 'main') {
      return Drupal.t('Main');
    }
    if (key === 'hill') {
      return Drupal.t('Hill');
    }
    if (key === 'online') {
      return Drupal.t('Online');
    }
    return String(rowLabel || '').split(/\s+/)[0] || rowLabel;
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
    if (typeof entry.openHour === 'number' && typeof entry.closeHour === 'number') {
      return formatHourFraction(entry.openHour) + ' – ' + formatHourFraction(entry.closeHour);
    }
    if (entry.label) {
      return entry.label;
    }
    return null;
  }

  function formatHourFraction(hour) {
    const totalMinutes = Math.round(hour * 60);
    if (totalMinutes % 1440 === 0) {
      return Drupal.t('midnight');
    }
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
   * Tomorrow's date key, for the homepage variant's "Tomorrow" badge.
   *
   * Derived from todayDateKey() rather than from a second `new Date()`, so
   * the two can never disagree across a midnight tick, and stepped in UTC
   * on purpose: setDate() on a local date crossing a DST boundary can land
   * on the same calendar day again or skip one, and this only ever needs
   * the next calendar square, not a duration.
   *
   * @return {string}
   *   Tomorrow as a Y-m-d key, or '' if today's key could not be parsed.
   */
  function tomorrowDateKey() {
    const date = new Date(todayDateKey() + 'T00:00:00Z');
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
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

  /**
   * Day name for a homepage column head: "Wednesday, Sep 30".
   *
   * The weekday is spelled out. "FRI" is a compression the reader has to
   * expand, and it was buying less than it looked: set uppercase and
   * tracked out, the long form is about 135px wide, which a third-width
   * card carries without wrapping even beside the Today badge.
   *
   * The month comes along with it, and that is a constraint rather than a
   * choice. There is no CLDR pattern for "weekday + day of month" on its
   * own, so asking Intl for `{ weekday, day }` and nothing else does not
   * return "Wednesday 30" - en-US resolves it to "30 Wednesday", and other
   * locales are free to be stranger still. Hand-joining the two parts
   * would mean inventing word order for every locale this module has not
   * been tested in. Delegating to formatDayLabel()'s long form asks Intl
   * for a real pattern instead and takes the redundant month as the price
   * of a string that is correctly ordered everywhere.
   *
   * @param {string} day
   *   ISO date string.
   *
   * @return {string}
   *   Localised full weekday, short month and day of month.
   */
  function formatHomepageDayName(day) {
    return formatDayLabel(day, true);
  }

  /**
   * A homepage header endpoint, fully spelled out: "Wednesday, September
   * 30". The long form of formatDayLabel(), for the one line that has the
   * width to carry it.
   *
   * @param {string} day
   *   ISO date string.
   *
   * @return {string}
   *   Localised full weekday, full month and day of month.
   */
  function formatRangeEndpoint(day) {
    const date = new Date(day + 'T00:00:00');
    if (Number.isNaN(date.getTime())) {
      return day;
    }
    try {
      return date.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
    }
    catch (e) {
      return formatDayLabel(day, true);
    }
  }

  /**
   * Matches a 12-hour clock label as LibCal formats it - "4:00 PM",
   * "9:30 AM", occasionally with seconds ("11:59:59 PM") - and captures
   * the pieces needed to shorten it. Anything else (a 24-hour locale, a
   * localised meridiem, a malformed value) simply fails to match, which
   * is how formatCompactTimeRange() knows to leave the label alone.
   */
  const CLOCK_LABEL_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP])\.?M\.?$/i;

  /**
   * Collapses a pair of clock labels into one compact range:
   * "4:00 PM"/"5:00 PM" becomes "4–5 PM", "9:00 AM"/"3:30 PM" becomes
   * "9 AM–3:30 PM".
   *
   * Two reductions, both of redundancy rather than information:
   *
   * - `:00` is dropped. A trailing double zero is the most common string
   *   in the column and the least informative; "4 PM" and "4:00 PM" say
   *   the same thing, and only one of them survives a 64px track without
   *   wrapping.
   * - A meridiem repeated on both ends is printed once, on the end that
   *   is ambiguous without it. "4–5 PM" cannot be misread. When the range
   *   crosses noon or midnight the meridiem differs, carries real
   *   information, and both are kept ("9 AM–3:30 PM").
   *
   * This is a homepage-only treatment. The grid variant's bars are
   * measured against a time axis where the exact clock label is the
   * payload, so they keep the unabbreviated form.
   *
   * @param {string} startLabel
   *   Start time as formatted by the feed.
   * @param {string} endLabel
   *   End time as formatted by the feed.
   *
   * @return {string}
   *   The compacted range, or the labels joined verbatim when either one
   *   is not a clock label this function recognises.
   */
  function formatCompactTimeRange(startLabel, endLabel) {
    const verbatim = startLabel + '–' + endLabel;
    const start = CLOCK_LABEL_PATTERN.exec(String(startLabel || '').trim());
    const end = CLOCK_LABEL_PATTERN.exec(String(endLabel || '').trim());
    if (!start || !end) {
      return verbatim;
    }

    const startClock = start[1] + (start[2] === '00' ? '' : ':' + start[2]);
    const endClock = end[1] + (end[2] === '00' ? '' : ':' + end[2]);
    const startMeridiem = start[3].toUpperCase() + 'M';
    const endMeridiem = end[3].toUpperCase() + 'M';
    const startText = start[1] === '12' && start[2] === '00' && start[3].toUpperCase() === 'A'
      ? Drupal.t('midnight')
      : startClock + ' ' + startMeridiem;
    const endText = end[1] === '12' && end[2] === '00' && end[3].toUpperCase() === 'A'
      ? Drupal.t('midnight')
      : endClock + ' ' + endMeridiem;

    return startMeridiem === endMeridiem && startText !== Drupal.t('midnight')
      ? startClock + '–' + endText
      : startText + '–' + endText;
  }

  /**
   * Shortens a single clock label the same way formatCompactTimeRange()
   * shortens a pair: "12:00 AM" becomes "12 AM", "9:30 AM" is left alone
   * because the half hour is information. Used by the hours strip, so
   * "open until 12 AM" is punctuated like the event times above it rather
   * than being the one place that still prints a double zero.
   *
   * @param {string} label
   *   A clock label.
   *
   * @return {string}
   *   The shortened label, or the input unchanged when it is not a clock
   *   label this module recognises.
   */
  function compactClockLabel(label) {
    const parts = CLOCK_LABEL_PATTERN.exec(String(label || '').trim());
    if (!parts) {
      return String(label || '');
    }
    if (parts[1] === '12' && parts[2] === '00' && parts[3].toUpperCase() === 'A') {
      return Drupal.t('midnight');
    }
    return parts[1]
      + ':' + parts[2]
      + ' ' + parts[3].toUpperCase() + 'M';
  }

  /**
   * Sorts a venue name into one of the buckets the venue tag is coloured
   * by: 'online', 'hill', 'main', or 'other'.
   *
   * Matched on substrings rather than compared against exact configured
   * labels, because the same place arrives spelled several ways across the
   * feed and the block settings - "Main Library", "LSU Library", "Hill
   * Memorial", "Hill Memorial Library" - and a lookup table of exact
   * strings would silently stop colouring the day someone renames a
   * calendar.
   *
   * Anything unrecognised returns 'other', which is a real style (a
   * neutral outlined tag), not a failure: a library that adds a fourth
   * location gets a correct, legible tag immediately and a colour for it
   * whenever someone gets round to choosing one.
   *
   * @param {string} venue
   *   Venue name as shown in the tag.
   *
   * @return {string}
   *   Bucket key for the `data-venue` attribute.
   */
  function venueKey(venue) {
    const text = String(venue || '').toLowerCase();
    if (text.indexOf('online') !== -1
      || text.indexOf('virtual') !== -1
      || text.indexOf('zoom') !== -1
      || text.indexOf('webinar') !== -1) {
      return 'online';
    }
    if (text.indexOf('hill') !== -1) {
      return 'hill';
    }
    if (text.indexOf('main') !== -1 || text.indexOf('lsu library') !== -1) {
      return 'main';
    }
    return 'other';
  }

  /**
   * The Monday of whatever week `day` falls in, as a Y-m-d key. One
   * definition of "week" shared by every path that folds Library Displays
   * together - the weekday merge in getRenderableEvents(), the weekend
   * strip, and the mobile agenda's weekly display group - so the three
   * cannot drift apart.
   */
  function weekStartKey(day) {
    const date = new Date(day + 'T12:00:00');
    if (Number.isNaN(date.getTime())) {
      return day;
    }
    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const year = monday.getFullYear();
    const month = String(monday.getMonth() + 1).padStart(2, '0');
    const dayOfMonth = String(monday.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + dayOfMonth;
  }

  /**
   * "Sep 15 - Oct 3" for a merged display, or one date when the run is a
   * single day. Read from the event's OWN segments rather than from the
   * days currently on screen: the visitor's question is how long the
   * display is up, not how much of it this week happens to show.
   */
  function formatDisplayRange(event) {
    const days = Object.keys(event.segments || {}).sort();
    if (!days.length) {
      return '';
    }
    const shortDate = (day) => {
      const date = new Date(day + 'T00:00:00');
      if (Number.isNaN(date.getTime())) {
        return day;
      }
      try {
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }
      catch (e) {
        return day;
      }
    };
    const from = shortDate(days[0]);
    const to = shortDate(days[days.length - 1]);
    return from === to ? from : Drupal.t('@from \u2013 @to', { '@from': from, '@to': to });
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
