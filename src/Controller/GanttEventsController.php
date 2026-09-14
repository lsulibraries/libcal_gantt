<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt\Controller;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Core\Controller\ControllerBase;
use Drupal\libcal_gantt\Service\LibCalClient;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * Serves the normalized, weekday-filtered event feed the front end reads.
 *
 * This is the only endpoint the browser ever calls. It does all timezone
 * and date-window math on the server (in the site's configured timezone)
 * so the JavaScript only has to position pre-computed numbers - no
 * client-side timezone conversion, no client-visible LibCal credentials.
 */
class GanttEventsController extends ControllerBase {

  public function __construct(
    protected readonly LibCalClient $libcalClient,
    protected readonly TimeInterface $time,
  ) {}

  public static function create(ContainerInterface $container): static {
    return new static(
      $container->get('libcal_gantt.client'),
      $container->get('datetime.time'),
    );
  }

  public function getEvents(Request $request): JsonResponse {
    // config() is inherited from ControllerBase (via ConfigFactoryTrait) -
    // deliberately not injecting our own ConfigFactoryInterface here, since
    // that property name collides with the one the trait already declares
    // and PHP won't allow redeclaring it as readonly.
    $config = $this->config('libcal_gantt.settings');

    $timezoneName = (string) ($config->get('timezone') ?: $this->config('system.date')->get('timezone.default') ?: date_default_timezone_get());
    try {
      $timezone = new \DateTimeZone($timezoneName);
    }
    catch (\Exception) {
      $timezone = new \DateTimeZone('UTC');
    }

    $dayStartHour = (int) ($config->get('day_start_hour') ?? 8);
    $dayEndHour = (int) ($config->get('day_end_hour') ?? 21);
    $weekdayCount = max(1, (int) ($config->get('weekday_count') ?: 10));
    $onlineKeywords = array_values(array_filter(array_map(
      static fn (string $keyword): string => strtolower(trim($keyword)),
      explode(',', (string) $config->get('online_location_keywords'))
    )));

    // The chart's row roster is a fixed allowlist, not discovered from
    // event data: only events that land in one of these configured
    // campus rows, or that are detected as online, are shown at all -
    // anything else (a campus ID that isn't listed) is left off the
    // chart entirely. Rows are always rendered in this order, even ones
    // with zero events in the current window, since they represent
    // known locations rather than "whatever happened to have events."
    // The online row is always first, ahead of every configured campus
    // row.
    $campusRows = LibCalClient::parseCampusRows((string) $config->get('campus_rows'));
    $onlineRowLabel = trim((string) $config->get('online_row_label')) ?: 'Online Event';
    $rowLabels = array_merge([$onlineRowLabel], array_values($campusRows));

    // The module can be configured with more than one switchable
    // "calendar" tab (see "Calendars" on the settings form and
    // LibCalClient::parseCalendars()) - each backed by one or more
    // LibCal calendar IDs merged together. The front end requests a
    // specific tab via ?calendar=<key> (the key being that tab's first
    // calendar ID, as a string); an unrecognized or missing key falls
    // back to the first configured tab, so a first page load with no
    // query parameter at all still works. Only that one tab's IDs are
    // fetched per request - switching tabs is a fresh request, not a
    // client-side filter over already-fetched events, so a tab's own
    // events are never even downloaded until it's selected.
    $calendars = LibCalClient::parseCalendars((string) $config->get('calendars'));
    $calendarKeys = array_keys($calendars);
    $requestedCalendar = (string) $request->query->get('calendar', '');
    $selectedCalendarKey = ($requestedCalendar !== '' && isset($calendars[$requestedCalendar]))
      ? $requestedCalendar
      : ($calendarKeys[0] ?? NULL);
    $selectedCalendarIds = $selectedCalendarKey !== NULL ? $calendars[$selectedCalendarKey]['ids'] : [];

    $calendarList = [];
    foreach ($calendars as $key => $calendar) {
      $calendarList[] = ['id' => $key, 'label' => $calendar['label']];
    }

    // Lets the "show more" button in the front end page forward through
    // time: offset=10 means "skip the 10 weekdays already shown and
    // return the next page." Defaults to 0 (today's window). Switching
    // calendar tabs also uses offset=0 - it's a fresh view, not a
    // continuation of whatever page the previous tab had scrolled to.
    $offset = max(0, (int) $request->query->get('offset', 0));

    $days = $this->buildWeekdayList($timezone, $weekdayCount, $offset);
    $dateStart = reset($days);
    $dateEnd = end($days);

    // LibCal's `days` parameter counts consecutive calendar days, so we
    // have to request a wider window to cover the weekday span (it
    // includes any weekends in between) and then discard non-listed days
    // below.
    $startDate = new \DateTime($dateStart, $timezone);
    $endDateExclusive = (new \DateTime($dateEnd, $timezone))->modify('+1 day');
    $spanDays = max(1, (int) $startDate->diff($endDateExclusive)->days);

    $rawEvents = $this->libcalClient->getUpcomingEvents($selectedCalendarIds, $dateStart, $spanDays);
    $daySet = array_flip($days);
    $events = [];

    foreach ($rawEvents as $event) {
      $prepared = $this->prepareEvent($event, $daySet, $timezone, $dayStartHour, $dayEndHour, $onlineKeywords, $campusRows, $onlineRowLabel);
      if ($prepared) {
        $events[] = $prepared;
      }
    }

    $campusHoursFeedUrls = (array) ($config->get('campus_hours_feed_urls') ?: []);
    $campusHoursLids = (array) ($config->get('campus_hours_lids') ?: []);
    $hours = $this->prepareAllHours($campusRows, $campusHoursFeedUrls, $campusHoursLids, (string) $config->get('hours_feed_url'), $daySet, $timezone);

    $response = new JsonResponse([
      'days' => $days,
      'dayStartHour' => $dayStartHour,
      'dayEndHour' => $dayEndHour,
      'rows' => $rowLabels,
      'events' => $events,
      'hours' => $hours,
      'calendars' => $calendarList,
      'calendar' => $selectedCalendarKey,
      'offset' => $offset,
      'generated' => $this->time->getRequestTime(),
    ]);
    // The route already disables page caching (options: no_cache); this
    // keeps intermediate proxies/CDNs from caching stale event windows too.
    $response->setPrivate();
    $response->setMaxAge(0);
    return $response;
  }

  /**
   * Builds the list of $count weekdays (Mon-Fri) as Y-m-d strings,
   * starting from today and skipping the first $offset weekdays - so
   * offset=0 is "today's window" and offset=10 is "the 10 weekdays after
   * that," which is what the front end's "show more" button requests.
   */
  protected function buildWeekdayList(\DateTimeZone $timezone, int $count, int $offset = 0): array {
    $cursor = new \DateTime('now', $timezone);
    $cursor->setTime(0, 0, 0);

    $seen = 0;
    $days = [];
    // Safety cap so a pathological offset can't loop indefinitely.
    $maxIterations = ($offset + $count) * 3 + 60;

    for ($i = 0; $i < $maxIterations && count($days) < $count; $i++) {
      // ISO-8601 day of week: 1 (Monday) through 7 (Sunday).
      if ((int) $cursor->format('N') < 6) {
        if ($seen >= $offset) {
          $days[] = $cursor->format('Y-m-d');
        }
        $seen++;
      }
      $cursor->modify('+1 day');
    }

    return $days;
  }

  /**
   * Fetches and normalizes building hours for every configured row.
   *
   * Each row can name its own Hours widget feed URL (set per-row in the
   * "Building hours" section of the settings form, keyed by campus ID in
   * the `campus_hours_feed_urls` config); a row that doesn't have one
   * falls back to the single site-wide "Hours feed URL (default)"
   * setting, so a single-building site can keep using just that one
   * field. The online-events row never gets hours - "open/closed"
   * doesn't mean anything for something that isn't a physical space.
   *
   * Multiple rows sharing the same feed URL (e.g. two rows both falling
   * back to the same site-wide default) only fetch it once per request;
   * LibCalClient::getHours() also caches each URL's result independently
   * in Drupal's cache, so repeat requests don't refetch either.
   *
   * @param array<int, string> $campusRows
   *   Ordered campus ID => row label map, from
   *   LibCalClient::parseCampusRows().
   * @param array<int|string, string> $campusHoursFeedUrls
   *   Campus ID => Hours feed URL, from the `campus_hours_feed_urls`
   *   config (only rows with their own feed URL configured appear here).
   * @param array<int|string, int|string> $campusHoursLids
   *   Campus ID => LibCal Hours "lid" (location ID) within that row's
   *   feed, from the `campus_hours_lids` config. Only needed when a feed
   *   URL bundles multiple buildings into one response (LibCal's
   *   "Weekly Data" widget commonly does - see scopeHoursToLocation()) -
   *   without it, two rows sharing the same feed URL would otherwise
   *   both be given whichever building's hours happen to appear first in
   *   that response.
   *
   * @return array<string, array<string, array{label: string|null, closed: bool, openHour: float|null, closeHour: float|null}>>
   *   Keyed by row label, then by Y-m-d date string. A row with no feed
   *   configured (and no site-wide default) or no data for a given day
   *   is simply absent from its level of the map.
   */
  protected function prepareAllHours(array $campusRows, array $campusHoursFeedUrls, array $campusHoursLids, string $defaultFeedUrl, array $daySet, \DateTimeZone $timezone): array {
    $hoursByRow = [];
    $rawByFeedUrl = [];

    foreach ($campusRows as $campusId => $label) {
      $feedUrl = trim((string) ($campusHoursFeedUrls[$campusId] ?? ''));
      if ($feedUrl === '') {
        $feedUrl = $defaultFeedUrl;
      }
      if ($feedUrl === '') {
        continue;
      }

      if (!array_key_exists($feedUrl, $rawByFeedUrl)) {
        $rawByFeedUrl[$feedUrl] = $this->libcalClient->getHours($feedUrl);
      }

      if ($rawByFeedUrl[$feedUrl]) {
        $targetLid = isset($campusHoursLids[$campusId]) && $campusHoursLids[$campusId] !== ''
          ? (int) $campusHoursLids[$campusId]
          : NULL;
        $prepared = $this->prepareHours($rawByFeedUrl[$feedUrl], $daySet, $timezone, $targetLid);
        if ($prepared) {
          $hoursByRow[$label] = $prepared;
        }
      }
    }

    return $hoursByRow;
  }

  /**
   * Normalizes one raw LibCal event and computes its per-day bar segments.
   *
   * @return array<string, mixed>|null
   *   NULL if the event has no usable start time, touches none of the
   *   displayed days, or - per the "Location rows" setting - isn't
   *   online and its campus doesn't match any configured row. That last
   *   case is deliberate filtering, not a bug: only events belonging to
   *   an allowlisted row are shown at all.
   */
  protected function prepareEvent(array $event, array $daySet, \DateTimeZone $timezone, int $dayStartHour, int $dayEndHour, array $onlineKeywords, array $campusRows, string $onlineRowLabel): ?array {
    if (empty($event['start'])) {
      return NULL;
    }

    try {
      $start = new \DateTime($event['start']);
      $start->setTimezone($timezone);
      $end = !empty($event['end']) ? new \DateTime($event['end']) : clone $start;
      $end->setTimezone($timezone);
    }
    catch (\Exception) {
      return NULL;
    }

    if ($end < $start) {
      $end = clone $start;
    }

    $segments = [];
    $cursor = (clone $start)->setTime(0, 0, 0);
    $lastDay = (clone $end)->setTime(0, 0, 0);

    // Guard against unexpectedly long spans.
    $safety = 0;
    while ($cursor <= $lastDay && $safety < 60) {
      $safety++;
      $dayKey = $cursor->format('Y-m-d');

      if (isset($daySet[$dayKey])) {
        $dayOpen = (clone $cursor)->setTime($dayStartHour, 0, 0);
        $dayClose = (clone $cursor)->setTime($dayEndHour, 0, 0);
        $segmentStart = max($start, $dayOpen);
        $segmentEnd = min($end, $dayClose);

        if ($segmentEnd > $segmentStart) {
          $segments[$dayKey] = [
            'startHour' => $this->toHourFraction($segmentStart),
            'endHour' => $this->toHourFraction($segmentEnd),
          ];
        }
        elseif (count($daySet) && $start->format('Y-m-d') === $end->format('Y-m-d') && $dayKey === $start->format('Y-m-d')) {
          // Same-day event entirely outside the configured display
          // hours (e.g. an early-morning setup task) - still show a
          // thin marker rather than silently dropping it.
          $segments[$dayKey] = [
            'startHour' => $dayStartHour,
            'endHour' => min($dayEndHour, $dayStartHour + 0.25),
          ];
        }
      }

      $cursor->modify('+1 day');
    }

    if (empty($segments)) {
      return NULL;
    }

    $location = '';
    if (!empty($event['location'])) {
      $location = is_array($event['location']) ? (string) ($event['location']['name'] ?? '') : (string) $event['location'];
    }

    $isOnline = $this->isOnlineEvent($event, $location, $onlineKeywords);

    if ($isOnline) {
      $row = $onlineRowLabel;
    }
    else {
      $campusId = 0;
      if (!empty($event['campus'])) {
        $campusId = is_array($event['campus']) ? (int) ($event['campus']['id'] ?? 0) : (int) $event['campus'];
      }
      $row = $campusRows[$campusId] ?? NULL;
    }

    // Not online and not one of the allowlisted campuses - excluded from
    // the chart entirely rather than dumped into a generic catch-all row.
    if ($row === NULL) {
      return NULL;
    }

    $url = '';
    if (!empty($event['url'])) {
      $url = is_array($event['url']) ? (string) ($event['url']['public'] ?? '') : (string) $event['url'];
    }

    return [
      'id' => $event['id'] ?? NULL,
      'title' => (string) ($event['title'] ?? 'Untitled event'),
      'location' => $location,
      'isOnline' => $isOnline,
      'row' => $row,
      'url' => $url,
      'startLabel' => $start->format('g:i A'),
      'endLabel' => $end->format('g:i A'),
      'segments' => $segments,
    ];
  }

  /**
   * Whether an event is online/virtual.
   *
   * LibCal's own "Online Event" feature (its built-in Zoom/Teams/etc.
   * meeting integration) populates a set of `online_*` fields -
   * `online_provider`, `online_join_url`, `online_meeting_id` - whenever
   * an event is configured that way, regardless of what's typed into the
   * separate `location` field. In practice a fully-online event commonly
   * leaves `location` blank entirely, since the physical location field
   * is meaningless for it - so this is checked first, as a real,
   * structured signal Springshare controls rather than free text typed
   * into a room name.
   *
   * As a fallback for events that are online without using that built-in
   * integration (e.g. a library just types "Online" or "Zoom" into the
   * location field, or pastes a Google Meet link in the description),
   * the configured keyword list is still checked against the location
   * text too. If neither signal matches, the event isn't treated as
   * online - it's then filtered by campus ID instead (see
   * prepareEvent()), same as any in-person event.
   */
  protected function isOnlineEvent(array $event, string $location, array $onlineKeywords): bool {
    foreach (['online_provider', 'online_join_url', 'online_meeting_id'] as $key) {
      if (!empty($event[$key])) {
        return TRUE;
      }
    }

    return $this->isOnlineLocation($location, $onlineKeywords);
  }

  /**
   * Whether a location string identifies an online/virtual event, per the
   * configured keyword list (e.g. "online", "virtual", "zoom", "teams").
   * Matching is a case-insensitive substring check, so a location like
   * "Online - Zoom" or "Virtual Reference Desk" still matches. Only a
   * fallback - see isOnlineEvent() - since most online events are better
   * identified by LibCal's own online_* fields.
   */
  protected function isOnlineLocation(string $location, array $onlineKeywords): bool {
    if ($location === '' || empty($onlineKeywords)) {
      return FALSE;
    }

    $haystack = strtolower($location);
    foreach ($onlineKeywords as $keyword) {
      if ($keyword !== '' && str_contains($haystack, $keyword)) {
        return TRUE;
      }
    }

    return FALSE;
  }

  protected function toHourFraction(\DateTime $dateTime): float {
    return (float) $dateTime->format('H') + ((float) $dateTime->format('i') / 60);
  }

  /**
   * Extracts building/location hours per displayed day from LibCal's
   * Hours widget JSON feed, for one location within it.
   *
   * The exact response shape isn't part of Springshare's documented OAuth
   * REST API - it comes from the public "Hours" widget feed each
   * institution generates itself (LibCal Admin > Hours > Widgets >
   * Weekly Data, JSON format), and Springshare's widget JSON has varied
   * across versions. Confirmed against a real LSU feed: the response is
   * `{"locations": [{"lid": 241, "name": "LSU Library", "weeks": [...]},
   * ...]}` - i.e. ONE feed URL commonly bundles every building's hours
   * together in a single response, disambiguated only by `lid`, rather
   * than each building having its own separate feed URL. $targetLid
   * narrows the search down to one location's `weeks` subtree when the
   * feed has a top-level `locations` array (see scopeHoursToLocation());
   * without a matching lid, or for a feed that isn't shaped this way,
   * this falls back to scanning the whole payload for any node with a
   * `date` field matching a displayed day, trying a few common
   * field-name variants for the rendered label and structured open/close
   * times. If a real feed uses different field names than what's handled
   * here, parseHoursNode() is the only method that needs adjusting -
   * share a sample JSON response and the parsing can be tightened.
   *
   * @return array<string, array{label: string|null, closed: bool, openHour: float|null, closeHour: float|null}>
   *   Keyed by Y-m-d date string, only for days where something usable
   *   was found.
   */
  protected function prepareHours(array $rawHours, array $daySet, \DateTimeZone $timezone, ?int $targetLid = NULL): array {
    $byDay = [];
    $scoped = $this->scopeHoursToLocation($rawHours, $targetLid);
    $this->collectHoursNodes($scoped, $daySet, $timezone, $byDay);
    return $byDay;
  }

  /**
   * Narrows a raw Hours feed payload down to one location's data.
   *
   * A single LibCal "Weekly Data" Hours widget feed URL commonly returns
   * every configured building in one response (`{"locations": [{"lid":
   * 241, ...}, {"lid": 236, ...}, ...]}`), not one feed per building.
   * Without this, collectHoursNodes()'s generic recursive scan would
   * grab whichever location's `date` node it happens to reach first in
   * the structure - silently giving every row the SAME building's hours
   * whenever two rows share a feed URL, which is the common case here
   * (multi-location feeds are, by definition, the same URL for every
   * row). When a target lid is configured for this row (see "Location
   * ID (lid)" on the settings form) and the feed has a top-level
   * `locations` array, this returns just that location's subtree.
   * Otherwise - single-location feed, or no lid configured for this row
   * - it returns the feed unchanged, same as before this method existed.
   */
  protected function scopeHoursToLocation(array $rawHours, ?int $targetLid): array {
    if ($targetLid === NULL) {
      return $rawHours;
    }

    $locations = $rawHours['locations'] ?? $rawHours['Locations'] ?? NULL;
    if (!is_array($locations)) {
      return $rawHours;
    }

    foreach ($locations as $location) {
      if (!is_array($location)) {
        continue;
      }
      $lid = $location['lid'] ?? $location['Lid'] ?? $location['id'] ?? NULL;
      if ($lid !== NULL && (int) $lid === $targetLid) {
        return $location;
      }
    }

    // The configured lid wasn't found in this response - fall back to
    // scanning the whole payload rather than returning nothing, so a
    // stale/mismatched lid degrades to the old (imprecise, "whichever
    // location comes first") behavior instead of silently hiding hours
    // for the row entirely.
    return $rawHours;
  }

  /**
   * Recursively scans a decoded JSON structure for date-keyed hours
   * entries, stopping at the first match found for each day (the feed's
   * own structure may repeat a date across nested wrappers).
   */
  protected function collectHoursNodes(mixed $node, array $daySet, \DateTimeZone $timezone, array &$byDay, int $depth = 0): void {
    // Guards against unexpectedly deep/circular structures.
    if (!is_array($node) || $depth > 8) {
      return;
    }

    $dateValue = $node['date'] ?? $node['Date'] ?? NULL;
    if (is_string($dateValue) && $dateValue !== '') {
      try {
        $dayKey = (new \DateTime($dateValue, $timezone))->format('Y-m-d');
      }
      catch (\Exception) {
        $dayKey = NULL;
      }

      if ($dayKey !== NULL && isset($daySet[$dayKey]) && !isset($byDay[$dayKey])) {
        $parsed = $this->parseHoursNode($node);
        if ($parsed['label'] !== NULL || $parsed['closed'] || $parsed['openHour'] !== NULL) {
          $byDay[$dayKey] = $parsed;
        }
      }
    }

    foreach ($node as $value) {
      if (is_array($value)) {
        $this->collectHoursNodes($value, $daySet, $timezone, $byDay, $depth + 1);
      }
    }
  }

  /**
   * Parses a single date-keyed node from the hours feed into a normalized
   * shape, trying several plausible field-name variants.
   */
  protected function parseHoursNode(array $node): array {
    $label = NULL;
    foreach (['rendered', 'Rendered', 'hours_html', 'display'] as $key) {
      if (!empty($node[$key]) && is_string($node[$key])) {
        $label = trim(strip_tags($node[$key]));
        break;
      }
    }

    // A real LibCal "Weekly Data" widget response nests the day's actual
    // status/hours under a `times` sub-object rather than putting them
    // directly on the day node - e.g. {"date": ..., "times": {"status":
    // "open", "hours": [{"from": "7am", "to": "12am"}], "currently_open":
    // true}, "rendered": "7am - 12am"}. Look there first, since that's
    // what an actual feed uses; fall back to the day node itself for any
    // other Springshare widget version/shape that puts status/hours at
    // the top level instead.
    $times = $node['times'] ?? $node['Times'] ?? NULL;
    $timesIsWrapper = is_array($times);

    $statusText = '';
    foreach (['status', 'Status'] as $key) {
      $source = $timesIsWrapper && isset($times[$key]) ? $times : $node;
      if (!empty($source[$key]) && is_string($source[$key])) {
        $statusText = strtolower($source[$key]);
        break;
      }
    }

    $slots = NULL;
    if ($timesIsWrapper && isset($times['hours']) && is_array($times['hours'])) {
      $slots = $times['hours'];
    }
    else {
      // Legacy/alternate shapes: either the slots array is directly on
      // the day node under one of these keys, or - only when $times
      // wasn't itself already a wrapper object above - `times` holds the
      // slots array directly rather than a {status, hours} wrapper.
      foreach (['hours', 'Hours', 'times'] as $key) {
        if ($key === 'times' && $timesIsWrapper) {
          // Already tried and didn't have a usable 'hours' sub-array;
          // treating the wrapper object itself as a slots list would
          // misparse it (its values are a status string, an hours
          // array-of-arrays, and a boolean - none of which are
          // {from, to} slot objects), so skip it here.
          continue;
        }
        if (isset($node[$key]) && is_array($node[$key])) {
          $slots = $node[$key];
          break;
        }
      }
    }

    $openHour = NULL;
    $closeHour = NULL;
    if (is_array($slots)) {
      foreach ($slots as $slot) {
        if (!is_array($slot)) {
          continue;
        }
        $from = $slot['from'] ?? $slot['open'] ?? $slot['Open'] ?? NULL;
        $to = $slot['to'] ?? $slot['close'] ?? $slot['Close'] ?? NULL;
        $fromHour = is_string($from) ? $this->parseHourString($from) : NULL;
        $toHour = is_string($to) ? $this->parseHourString($to) : NULL;

        // A closing time of exactly midnight ("12am"/"12:00am") means
        // the location stays open through the end of that calendar day
        // (e.g. "7am - 12am"), not that it closes at the day's own
        // start - parseHourString() has no way to tell those apart from
        // the string alone, so without this a fully-open day would
        // otherwise get a spurious "Closes 12:00 AM" caption (0 being
        // less than practically any configured "day ends at" hour).
        // Representing it as 24 instead makes the appendClosingCaption()
        // comparison ("does it close before the display window ends?")
        // correctly treat this as closing AFTER the window, i.e. no
        // caption needed. Only applied to the closing side - an actual
        // midnight OPENING time (a 24-hour location) should stay 0.
        if ($toHour === 0.0) {
          $toHour = 24.0;
        }

        if ($fromHour !== NULL && ($openHour === NULL || $fromHour < $openHour)) {
          $openHour = $fromHour;
        }
        if ($toHour !== NULL && ($closeHour === NULL || $toHour > $closeHour)) {
          $closeHour = $toHour;
        }
      }
    }

    $closed = str_contains($statusText, 'closed')
      || (is_array($slots) && empty($slots) && $label !== NULL && stripos($label, 'closed') !== FALSE)
      || ($openHour === NULL && $closeHour === NULL && $label !== NULL && stripos($label, 'closed') !== FALSE);

    return [
      'label' => $label,
      'closed' => $closed,
      'openHour' => $closed ? NULL : $openHour,
      'closeHour' => $closed ? NULL : $closeHour,
    ];
  }

  /**
   * Parses a time string like "8:00am", "8:00 AM", or "08:00" into an
   * hour-of-day fraction. Returns NULL for anything it doesn't recognize
   * rather than guessing.
   */
  protected function parseHourString(string $value): ?float {
    $value = trim($value);
    foreach (['g:ia', 'g:iA', 'g:i a', 'g:i A', 'ga', 'gA', 'H:i', 'G:i'] as $format) {
      $parsed = \DateTime::createFromFormat($format, $value);
      if ($parsed !== FALSE) {
        return $this->toHourFraction($parsed);
      }
    }
    return NULL;
  }

}