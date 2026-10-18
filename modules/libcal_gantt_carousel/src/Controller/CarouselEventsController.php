<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt_carousel\Controller;

use Drupal\libcal_gantt\Controller\GanttEventsController;
use Drupal\libcal_gantt\Service\LibCalClient;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * The parent events endpoint, with weather for every forecastable day and
 * Wikipedia "On this day" facts for days with no timed events.
 *
 * The parent controller limits weather to self::WEATHER_DAYS (3), and
 * `self::` binds to the parent class, so a subclass cannot raise it by
 * redeclaring the constant. This controller calls the parent method as-is
 * and then fills in weather for the rest of the window, weekends included,
 * using the same WeatherClient service. The client caches NWS responses, so
 * this second call does not add an HTTP request.
 *
 * create() and the constructor are inherited unchanged.
 */
class CarouselEventsController extends GanttEventsController {

  public function getCarouselEvents(Request $request): JsonResponse {
    $response = $this->getEvents($request);

    $data = json_decode((string) $response->getContent(), TRUE);
    if (!is_array($data) || (int) ($data['offset'] ?? 0) !== 0 || empty($data['days'])) {
      return $response;
    }

    $data = $this->filterByCampus($data, (string) $request->query->get('campus', ''));

    $days = array_values((array) $data['days']);
    foreach ((array) ($data['weekends'] ?? []) as $weekend) {
      if (!empty($weekend['saturday'])) {
        $days[] = (string) $weekend['saturday'];
      }
      if (!empty($weekend['sunday'])) {
        $days[] = (string) $weekend['sunday'];
      }
    }
    sort($days);

    // Days NWS has no forecast for are left out of the result, so passing
    // the whole window is safe.
    $extended = $this->weatherClient->getForecast($days, $this->siteTimezone());
    $data['weather'] = $extended + (array) ($data['weather'] ?? []);

    // Wikipedia "On this day" for the carousel's quiet days, through the
    // parent's OnThisDayClient (same "Show Wikipedia On this day facts"
    // setting, cache and soft failure). The carousel's idea of quiet is
    // looser than the homepage's: a day with no TIMED events, so a day
    // that only has all-day items (a donation bin, an open room) still gets
    // a fact. The whole window is sent; the client caches per calendar date
    // and fetches cold dates in parallel. An object even when empty, as in
    // the parent payload (json_decode(assoc) turned its `{}` into `[]`).
    $data['onThisDay'] = $this->onThisDayClient->getFacts($this->quietDays((array) ($data['events'] ?? []), $days)) ?: new \stdClass();

    $response->setData($data);
    return $response;
  }

  /**
   * The days in $days that have no timed event.
   *
   * Every event carries a segment for each day it touches, weekends
   * included (the parent builds its weekend lists from these same events),
   * so one pass covers the whole window. A segment that runs the whole day
   * is all-day, the same test day-carousel.js uses for "All day".
   *
   * @param array<int, array<string, mixed>> $events
   *   The payload's events.
   * @param array<int, string> $days
   *   Y-m-d strings.
   *
   * @return array<int, string>
   *   Y-m-d strings.
   */
  protected function quietDays(array $events, array $days): array {
    $timed = [];
    foreach ($events as $event) {
      foreach ((array) ($event['segments'] ?? []) as $day => $segment) {
        $start = (float) ($segment['startHour'] ?? 0);
        $end = (float) ($segment['endHour'] ?? 24);
        if ($start > 0.01 || $end < 23.9) {
          $timed[(string) $day] = TRUE;
        }
      }
    }
    return array_values(array_filter($days, static fn (string $day): bool => !isset($timed[$day])));
  }

  /**
   * Keeps only events from the libraries in ?campus=262,261.
   *
   * The same filter as "LSU Libraries" (cm=) on LibCal's public calendar:
   * campus IDs from the "Campus rows" setting. An event's campus is kept
   * even when it is online, so a library's online events stay in, as on
   * LibCal. Building hours are cut down to the chosen libraries too.
   * Unknown IDs are ignored; none valid, or no ?campus, changes nothing.
   *
   * @param array<string, mixed> $data
   *   The decoded parent payload.
   *
   * @return array<string, mixed>
   */
  protected function filterByCampus(array $data, string $param): array {
    $rows = LibCalClient::parseCampusRows((string) $this->config('libcal_gantt.settings')->get('campus_rows'));
    $ids = array_values(array_filter(
      array_map('intval', explode(',', $param)),
      static fn (int $id): bool => isset($rows[$id]),
    ));
    if (!$ids) {
      return $data;
    }
    $wanted = array_flip($ids);
    $keep = static fn ($event): bool => is_array($event) && isset($wanted[(int) ($event['campusId'] ?? 0)]);

    $data['events'] = array_values(array_filter((array) ($data['events'] ?? []), $keep));

    foreach ((array) ($data['weekends'] ?? []) as $i => $weekend) {
      $byRow = [];
      foreach ((array) ($weekend['events'] ?? []) as $row => $events) {
        $events = array_values(array_filter((array) $events, $keep));
        if ($events) {
          $byRow[$row] = $events;
        }
      }
      // An object even when empty: day-carousel.js reads it as a map.
      $data['weekends'][$i]['events'] = $byRow ?: new \stdClass();
    }

    // Hours rows (and their order) for the chosen libraries only.
    $data['rows'] = array_values(array_intersect_key($rows, $wanted));
    $data['campus'] = implode(',', $ids);
    return $data;
  }

  /**
   * One tab, or several merged: ?calendar=8030,16219.
   *
   * Each comma-separated key must be a configured tab ("Calendars" on the
   * LibCal Gantt settings); unknown keys are ignored. With two or more
   * valid keys their LibCal IDs are merged (as a "8030,8031|Combined" line
   * would be) and the key reported back is the keys joined with commas.
   * One key, or none valid, behaves exactly like the parent.
   */
  protected function selectCalendar(Request $request, array $calendars): array {
    $keys = array_values(array_unique(array_filter(
      array_map('trim', explode(',', (string) $request->query->get('calendar', ''))),
      static fn (string $key): bool => $key !== '' && isset($calendars[$key]),
    )));
    if (count($keys) < 2) {
      return parent::selectCalendar($request->duplicate(['calendar' => $keys[0] ?? '']), $calendars);
    }
    $ids = [];
    foreach ($keys as $key) {
      $ids = array_merge($ids, $calendars[$key]['ids']);
    }
    return [implode(',', $keys), array_values(array_unique($ids))];
  }

  /**
   * Same timezone resolution as GanttEventsController::getEvents().
   */
  protected function siteTimezone(): \DateTimeZone {
    $config = $this->config('libcal_gantt.settings');
    $name = (string) ($config->get('timezone') ?: $this->config('system.date')->get('timezone.default') ?: date_default_timezone_get());
    try {
      return new \DateTimeZone($name);
    }
    catch (\Exception) {
      return new \DateTimeZone('UTC');
    }
  }

}
