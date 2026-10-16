<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt_carousel\Controller;

use Drupal\libcal_gantt\Controller\GanttEventsController;
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
