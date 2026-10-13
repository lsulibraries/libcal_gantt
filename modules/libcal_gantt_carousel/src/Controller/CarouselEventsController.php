<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt_carousel\Controller;

use Drupal\libcal_gantt\Controller\GanttEventsController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * The parent events endpoint, with weather for every forecastable day.
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

    // json_decode(assoc) turns the parent's `{}` placeholder into `[]`.
    // Restore it so the payload shape is identical to the parent's.
    if (empty($data['onThisDay'])) {
      $data['onThisDay'] = new \stdClass();
    }

    $response->setData($data);
    return $response;
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
