<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt\Service;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Core\Cache\CacheBackendInterface;
use Drupal\Core\Config\ConfigFactoryInterface;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;
use Psr\Log\LoggerInterface;

/**
 * Server-side client for the National Weather Service forecast API.
 *
 * Why NWS rather than a commercial weather API: no key to provision, no
 * quota to negotiate, no vendor terms to get reviewed, and the data is
 * already public record - which is also the easiest answer to give when
 * someone asks why the library homepage is calling a third-party service.
 *
 * TWO REQUESTS, NOT ONE. NWS has no ZIP or place lookup: /points/{lat},{lon}
 * resolves a coordinate to a forecast GRID and returns the URLs that grid's
 * data actually lives at, and those URLs are what carry the forecast. The
 * coordinate-to-grid mapping never changes for a building that doesn't
 * move, so it is cached for a month (self::GRID_CACHE_TTL) while the
 * forecast behind it is cached for minutes (`weather_cache_ttl`). The
 * coordinate itself is admin config rather than a geocoded address, because
 * geocoding two fixed buildings would mean a second external dependency to
 * serve a value that could just be typed in once.
 *
 * NWS requires a descriptive User-Agent with contact information and
 * answers 403 without one - see self::userAgent(), which is the single
 * likeliest reason a fresh install sees no forecast.
 *
 * PAST NWS'S WEEK, OPEN-METEO. NWS forecasts about seven days. Days 8 to
 * 16 (self::EXTENDED_HORIZON_DAYS), and a day from the third on that NWS
 * leaves out, come from Open-Meteo's daily forecast (api.open-meteo.com: no
 * key, CC BY 4.0, free for non-commercial use), one cached request, marked
 * `source: open-meteo` so the carousel can credit it. NWS stays first
 * wherever it has a day.
 *
 * EVERYTHING HERE FAILS SOFT. A missing coordinate, an NWS outage, a
 * throttled request, a changed response shape and an unparseable timestamp
 * all end at the same place: return an empty array, the controller omits
 * the `weather` key, and the front end renders no weather row - exactly as
 * it already does for a day with no hours. The events feed is what the
 * block is for, and a forecast must never be able to delay or break it.
 *
 * @see \Drupal\libcal_gantt\Controller\GanttEventsController::getEvents()
 */
class WeatherClient {

  /**
   * Shares LibCalClient's cache tag so one settings change clears both.
   */
  public const CACHE_TAG = LibCalClient::CACHE_TAG;

  /**
   * API root. Versioned via the Accept header, not the path.
   */
  protected const API_BASE = 'https://api.weather.gov';

  /**
   * How long a coordinate's resolved grid endpoints are cached. Effectively
   * permanent - a grid only changes if NWS redraws its forecast zones.
   */
  protected const GRID_CACHE_TTL = 2592000;

  /**
   * Precipitation below this percentage isn't worth a line. A row that
   * reads "0% rain" every day teaches people to stop looking at the strip,
   * which costs the hours sitting directly above it.
   *
   * Kept deliberately in sync with WEATHER_POP_THRESHOLD in
   * gantt-timeline.js: this decides whether an onset time is computed at
   * all, that decides which sentence gets built from it.
   */
  protected const POP_THRESHOLD = 30;

  /**
   * The window an onset time is looked for in, as local hours. Rain at 3 AM
   * changes nobody's walk to the library; the range brackets the earliest
   * opening and the latest closing across both buildings.
   */
  protected const DAY_WINDOW_START = 7;
  protected const DAY_WINDOW_END = 22;

  /**
   * How many days from today may carry an onset time.
   *
   * Two: today and tomorrow. NWS hourly timing past about 48 hours isn't
   * dependable enough to print "from ~3 PM" beside library hours, and a
   * wrong start time is worse than a vaguer line - the third day still
   * shows its percentage and its temperatures, just no hour.
   */
  protected const ONSET_HORIZON_DAYS = 2;

  /**
   * Open-Meteo's forecast endpoint, for the days past NWS's week.
   */
  protected const EXTENDED_API = 'https://api.open-meteo.com/v1/forecast';

  /**
   * How many days, from today, have a forecast at all: Open-Meteo's
   * longest daily forecast. Past that a forecast would be a guess, so those
   * days show no weather.
   */
  protected const EXTENDED_HORIZON_DAYS = 16;

  /**
   * The first day, from today, Open-Meteo may fill. The homepage Gantt's
   * weather days (GanttEventsController::WEATHER_DAYS, today and the next
   * two) stay NWS only: its strip has no room to credit another source.
   */
  protected const EXTENDED_FROM_DAYS = 3;

  public function __construct(
    protected readonly ClientInterface $httpClient,
    protected readonly ConfigFactoryInterface $configFactory,
    protected readonly CacheBackendInterface $cache,
    protected readonly TimeInterface $time,
    protected readonly LoggerInterface $logger,
  ) {}

  /**
   * Builds one forecast summary per requested day.
   *
   * @param array<int, string> $days
   *   The days to summarize, as Y-m-d strings in $timezone. Days NWS has
   *   no forecast for are simply absent from the result.
   * @param \DateTimeZone $timezone
   *   The site timezone the chart is rendered in. NWS timestamps carry
   *   their own offsets and are converted into this zone before their date
   *   and hour are read, so a forecast period is attributed to the day the
   *   visitor would call it.
   *
   * @return array<string, array<string, mixed>>
   *   Keyed by Y-m-d. Each summary carries `high`/`low` (int|null, degrees
   *   Fahrenheit), `pop` (int|null percent), `condition` (NWS short text),
   *   `icon` (see self::iconKey()), `startHour` (float|null hour fraction,
   *   the same units the hours pipeline uses for openHour/closeHour) and
   *   `sustained` (bool - wet for most of the day rather than from a point
   *   in it). An empty array means "render nothing," never "no rain."
   */
  public function getForecast(array $days, \DateTimeZone $timezone): array {
    $config = $this->configFactory->get('libcal_gantt.settings');
    if (!$config->get('show_weather') || !$days) {
      return [];
    }

    $lat = $this->coordinate((string) $config->get('weather_lat'), 90.0);
    $lon = $this->coordinate((string) $config->get('weather_lon'), 180.0);
    if ($lat === NULL || $lon === NULL) {
      return [];
    }

    $ttl = max(300, (int) ($config->get('weather_cache_ttl') ?: 1800));
    $today = (new \DateTimeImmutable('@' . $this->time->getRequestTime()))
      ->setTimezone($timezone)
      ->format('Y-m-d');

    $forecast = $this->nwsForecast($days, $lat, $lon, $today, $timezone, $ttl);

    // NWS stops at about seven days. The days after that, out to
    // self::EXTENDED_HORIZON_DAYS, come from Open-Meteo, and so does a day
    // from self::EXTENDED_FROM_DAYS on that NWS left out (an outage).
    $missing = [];
    foreach ($days as $day) {
      $day = (string) $day;
      $ahead = $this->daysFromToday($today, $day, $timezone);
      if (!isset($forecast[$day]) && $ahead >= self::EXTENDED_FROM_DAYS && $ahead < self::EXTENDED_HORIZON_DAYS) {
        $missing[] = $day;
      }
    }
    if ($missing) {
      $forecast += $this->extendedForecast($missing, $lat, $lon, $timezone, $ttl);
    }

    return $forecast;
  }

  /**
   * The NWS summaries for $days, keyed by Y-m-d; days NWS doesn't cover
   * (past about a week) are absent.
   */
  protected function nwsForecast(array $days, float $lat, float $lon, string $today, \DateTimeZone $timezone, int $ttl): array {
    $grid = $this->getGridUrls($lat, $lon);
    if (!$grid) {
      return [];
    }

    // The twelve-hour periods carry the high, the low, the day's
    // precipitation chance and the condition text. Without them there is
    // nothing to say, so the hourly request isn't even attempted.
    $periods = $this->fetchPeriods($grid['forecast'], 'daily', $ttl);
    if (!$periods) {
      return [];
    }
    // The hourly series is only used to locate an onset, so a failure here
    // degrades the sentence ("60% rain" instead of "60% rain from ~3 PM")
    // rather than the row.
    $hourly = $this->fetchPeriods($grid['forecastHourly'], 'hourly', $ttl);

    $forecast = [];
    foreach (array_values($days) as $day) {
      $withOnset = $hourly && $this->daysFromToday($today, (string) $day, $timezone) < self::ONSET_HORIZON_DAYS;
      $summary = $this->summarizeDay((string) $day, $periods, $withOnset ? $hourly : [], $timezone);
      if ($summary) {
        $forecast[$day] = $summary;
      }
    }

    return $forecast;
  }

  /**
   * Daily summaries from Open-Meteo for days NWS doesn't cover.
   *
   * One request for the whole horizon (daily values in the site timezone,
   * Fahrenheit), cached for the forecast TTL like the NWS documents, empty
   * results included. The same summary shape as summarizeDay(), with no
   * onset hour (NWS only gives one for the first two days anyway) and
   * `source: open-meteo`, which the carousel credits beside the forecast:
   * Open-Meteo's data is CC BY 4.0, free for non-commercial use, no key.
   *
   * @param array<int, string> $days
   *   Y-m-d strings within the horizon.
   *
   * @return array<string, array<string, mixed>>
   *   Keyed by Y-m-d; days Open-Meteo has nothing for are absent.
   */
  protected function extendedForecast(array $days, float $lat, float $lon, \DateTimeZone $timezone, int $ttl): array {
    $url = self::EXTENDED_API . '?' . http_build_query([
      'latitude' => round($lat, 4),
      'longitude' => round($lon, 4),
      'daily' => 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      'temperature_unit' => 'fahrenheit',
      'timezone' => $timezone->getName(),
      'forecast_days' => self::EXTENDED_HORIZON_DAYS,
    ]);

    $cacheId = 'libcal_gantt:weather:extended:' . md5($url);
    if ($cached = $this->cache->get($cacheId)) {
      $daily = $cached->data;
    }
    else {
      $data = $this->request($url, 'application/json');
      $daily = is_array($data['daily'] ?? NULL) ? $data['daily'] : [];
      // Temperatures only in Fahrenheit, as with NWS (temperature()).
      if (($data['daily_units']['temperature_2m_max'] ?? '°F') !== '°F') {
        unset($daily['temperature_2m_max'], $daily['temperature_2m_min']);
      }
      $this->cache->set($cacheId, $daily, $this->time->getRequestTime() + $ttl, [self::CACHE_TAG]);
    }

    $index = array_flip(array_map('strval', (array) ($daily['time'] ?? [])));
    $forecast = [];
    foreach ($days as $day) {
      if (!isset($index[$day])) {
        continue;
      }
      $i = $index[$day];
      $condition = $this->wmoCondition($daily['weather_code'][$i] ?? NULL);
      $high = $daily['temperature_2m_max'][$i] ?? NULL;
      $low = $daily['temperature_2m_min'][$i] ?? NULL;
      $high = is_numeric($high) ? (int) round((float) $high) : NULL;
      $low = is_numeric($low) ? (int) round((float) $low) : NULL;
      if ($condition === '' && $high === NULL && $low === NULL) {
        continue;
      }
      $forecast[$day] = [
        'high' => $high,
        'low' => $low,
        'pop' => $this->percent($daily['precipitation_probability_max'][$i] ?? NULL),
        'condition' => $condition,
        'icon' => $this->iconKey($condition),
        'startHour' => NULL,
        'sustained' => FALSE,
        'source' => 'open-meteo',
      ];
    }

    return $forecast;
  }

  /**
   * Words for a WMO weather code (Open-Meteo's weather_code), in NWS's
   * style so iconKey() reads them the same way; '' when unknown.
   */
  protected function wmoCondition(mixed $code): string {
    if (!is_numeric($code)) {
      return '';
    }
    $code = (int) $code;
    return match (TRUE) {
      $code === 0 => 'Sunny',
      $code === 1 => 'Mostly Sunny',
      $code === 2 => 'Partly Cloudy',
      $code === 3 => 'Cloudy',
      $code === 45, $code === 48 => 'Fog',
      $code >= 51 && $code <= 55 => 'Drizzle',
      $code === 56, $code === 57, $code === 66, $code === 67 => 'Freezing Rain',
      $code >= 61 && $code <= 65 => 'Rain',
      $code >= 71 && $code <= 77 => 'Snow',
      $code >= 80 && $code <= 82 => 'Rain Showers',
      $code === 85, $code === 86 => 'Snow Showers',
      $code >= 95 && $code <= 99 => 'Thunderstorms',
      default => '',
    };
  }

  /**
   * Reduces NWS's twelve-hour periods for one date to a single summary.
   *
   * A date normally has both a daytime and a nighttime period, giving a
   * high and a low. Today loses its daytime period once the afternoon
   * forecast rolls over in the early evening - which is precisely when
   * someone checks tonight's hours - so a date with only a night period
   * still returns a summary, with a low and no high, rather than nothing.
   */
  protected function summarizeDay(string $day, array $periods, array $hourly, \DateTimeZone $timezone): ?array {
    $dayPeriod = NULL;
    $nightPeriod = NULL;
    foreach ($periods as $period) {
      if (!is_array($period)) {
        continue;
      }
      $start = $this->localTime((string) ($period['startTime'] ?? ''), $timezone);
      if (!$start || $start->format('Y-m-d') !== $day) {
        continue;
      }
      if (!empty($period['isDaytime'])) {
        $dayPeriod ??= $period;
      }
      else {
        $nightPeriod ??= $period;
      }
    }

    $primary = $dayPeriod ?? $nightPeriod;
    if ($primary === NULL) {
      return NULL;
    }

    $condition = trim((string) ($primary['shortForecast'] ?? ''));
    $pop = $this->percent($primary['probabilityOfPrecipitation'] ?? NULL);
    if ($nightPeriod !== NULL && $dayPeriod !== NULL) {
      // The day's chance is the higher of its two halves: an evening
      // thunderstorm matters to a 7 PM program even when the afternoon is
      // dry, and the strip only has room for one number.
      $pop = max($pop ?? 0, $this->percent($nightPeriod['probabilityOfPrecipitation'] ?? NULL) ?? 0);
    }

    [$startHour, $sustained] = ($pop !== NULL && $pop >= self::POP_THRESHOLD && $hourly)
      ? $this->onset($day, $hourly, $timezone)
      : [NULL, FALSE];

    return [
      'high' => $dayPeriod !== NULL ? $this->temperature($dayPeriod) : NULL,
      'low' => $nightPeriod !== NULL ? $this->temperature($nightPeriod) : NULL,
      'pop' => $pop,
      'condition' => $condition,
      'icon' => $this->iconKey($condition),
      'startHour' => $startHour,
      'sustained' => $sustained,
    ];
  }

  /**
   * Finds the hour precipitation starts, from the hourly series.
   *
   * "From ~3 PM" is only meaningful if the day starts dry, so an onset is
   * reported only where the window opens below the threshold and later
   * crosses it. Rain already falling at 7 AM, or crossing the threshold for
   * most of the window, is reported as sustained instead - the front end
   * says "most of the day", which is both shorter and true.
   *
   * @return array{0: float|null, 1: bool}
   *   The onset as an hour fraction (null if there isn't a single clear
   *   one) and whether the day is wet throughout.
   */
  protected function onset(string $day, array $hourly, \DateTimeZone $timezone): array {
    $hours = [];
    foreach ($hourly as $period) {
      if (!is_array($period)) {
        continue;
      }
      $start = $this->localTime((string) ($period['startTime'] ?? ''), $timezone);
      if (!$start || $start->format('Y-m-d') !== $day) {
        continue;
      }
      $hour = (int) $start->format('G');
      if ($hour < self::DAY_WINDOW_START || $hour > self::DAY_WINDOW_END) {
        continue;
      }
      $hours[$hour] = $this->percent($period['probabilityOfPrecipitation'] ?? NULL) ?? 0;
    }

    if (count($hours) < 3) {
      // Too little of the window covered to characterize it - the day is
      // probably at its far edge, where the hourly series runs out.
      return [NULL, FALSE];
    }

    ksort($hours);
    $wet = count(array_filter($hours, static fn (int $pop): bool => $pop >= self::POP_THRESHOLD));
    if ($wet === 0) {
      // The day total cleared the threshold on an overnight hour outside
      // this window. Nothing to pin to a time, and not sustained either.
      return [NULL, FALSE];
    }
    if ($wet >= (int) ceil(count($hours) * 0.6)) {
      return [NULL, TRUE];
    }

    $first = array_key_first($hours);
    if ($hours[$first] >= self::POP_THRESHOLD) {
      // Already wet when the window opens. "From ~7 AM" would just be the
      // window's own edge dressed up as a forecast.
      return [NULL, TRUE];
    }

    foreach ($hours as $hour => $pop) {
      if ($pop >= self::POP_THRESHOLD) {
        return [(float) $hour, FALSE];
      }
    }

    return [NULL, FALSE];
  }

  /**
   * Resolves a coordinate to its NWS forecast endpoints.
   *
   * @return array{forecast: string, forecastHourly: string}|null
   *   The two URLs, or NULL if the lookup failed or returned neither.
   */
  protected function getGridUrls(float $lat, float $lon): ?array {
    // NWS rejects coordinates with more than four decimal places, and
    // rounding also keeps the cache ID stable against a trailing-digit
    // edit that doesn't move the point.
    $point = round($lat, 4) . ',' . round($lon, 4);
    $cacheId = 'libcal_gantt:weather:grid:' . md5($point);
    if ($cached = $this->cache->get($cacheId)) {
      return $cached->data ?: NULL;
    }

    $data = $this->request(self::API_BASE . '/points/' . $point);
    $forecast = (string) ($data['properties']['forecast'] ?? '');
    $hourly = (string) ($data['properties']['forecastHourly'] ?? '');
    if ($forecast === '') {
      return NULL;
    }

    $urls = ['forecast' => $forecast, 'forecastHourly' => $hourly];
    $this->cache->set($cacheId, $urls, $this->time->getRequestTime() + self::GRID_CACHE_TTL, [self::CACHE_TAG]);

    return $urls;
  }

  /**
   * Fetches and caches one forecast document's period list.
   */
  protected function fetchPeriods(string $url, string $kind, int $ttl): array {
    if ($url === '') {
      return [];
    }

    $cacheId = 'libcal_gantt:weather:' . $kind . ':' . md5($url);
    if ($cached = $this->cache->get($cacheId)) {
      return $cached->data;
    }

    $data = $this->request($url);
    $periods = $data['properties']['periods'] ?? NULL;
    $periods = is_array($periods) ? $periods : [];

    // Cached even when empty, so an NWS outage costs one failed request
    // per TTL rather than one per page view.
    $this->cache->set($cacheId, $periods, $this->time->getRequestTime() + $ttl, [self::CACHE_TAG]);

    return $periods;
  }

  /**
   * One GET against api.weather.gov, decoded, never allowed to throw.
   */
  protected function request(string $url, string $accept = 'application/geo+json'): array {
    try {
      $response = $this->httpClient->request('GET', $url, [
        'headers' => [
          // NWS: the documented versioned media type; plain
          // application/json works but pins nothing. Open-Meteo: JSON.
          'Accept' => $accept,
          'User-Agent' => $this->userAgent(),
        ],
        // Deliberately shorter than the LibCal timeouts. Weather is the
        // least important thing in the response and must not be what makes
        // the events endpoint feel slow.
        'timeout' => 6,
        'connect_timeout' => 3,
      ]);
      $data = json_decode((string) $response->getBody(), TRUE);
      return is_array($data) ? $data : [];
    }
    catch (GuzzleException $e) {
      $this->logger->warning('LibCal Gantt: weather request failed (@url): @message', [
        '@url' => $url,
        '@message' => $e->getMessage(),
      ]);
      return [];
    }
  }

  /**
   * Builds the User-Agent NWS asks for.
   *
   * Their terms ask for something identifying with a contact address, and
   * they answer 403 to a generic client string. Falls back to the site
   * email so a site that never fills the field in still identifies itself.
   */
  protected function userAgent(): string {
    $contact = trim((string) $this->configFactory->get('libcal_gantt.settings')->get('weather_contact'));
    if ($contact === '') {
      $contact = trim((string) $this->configFactory->get('system.site')->get('mail'));
    }

    return 'Drupal libcal_gantt' . ($contact !== '' ? ' (' . $contact . ')' : '');
  }

  /**
   * Maps NWS short-forecast text to one of the front end's icon keys.
   *
   * Order matters: "Chance Showers And Thunderstorms" is a storm before it
   * is rain, and "Partly Sunny" is partly cloudy before it is sunny.
   * Anything unrecognized returns an empty string, and the front end then
   * draws no icon at all rather than a confidently wrong one.
   */
  protected function iconKey(string $condition): string {
    $text = strtolower($condition);
    $map = [
      'storm' => ['thunder', 'tstorm', 'squall'],
      'snow' => ['snow', 'sleet', 'ice', 'flurr', 'wintry'],
      'rain' => ['rain', 'shower', 'drizzle'],
      'fog' => ['fog', 'haze', 'smoke', 'mist'],
      'part' => ['partly', 'mostly sunny', 'mostly clear', 'few clouds', 'partly sunny'],
      'cloud' => ['cloud', 'overcast'],
      'sun' => ['sunny', 'clear', 'fair', 'hot'],
    ];
    foreach ($map as $key => $needles) {
      foreach ($needles as $needle) {
        if (str_contains($text, $needle)) {
          return $key;
        }
      }
    }

    return '';
  }

  /**
   * Reads a temperature, only trusting Fahrenheit.
   *
   * NWS serves this endpoint in F for US locations, but the unit is part of
   * the payload, so a period arriving in C is dropped rather than printed
   * as if it were F - a 24° high on a Baton Rouge homepage is worse than no
   * high at all.
   */
  protected function temperature(array $period): ?int {
    $value = $period['temperature'] ?? NULL;
    $unit = strtoupper((string) ($period['temperatureUnit'] ?? 'F'));
    if (!is_numeric($value) || $unit !== 'F') {
      return NULL;
    }

    return (int) round((float) $value);
  }

  /**
   * Reads NWS's {value, unitCode} percentage wrapper, whose value is
   * routinely null for a dry period.
   */
  protected function percent(mixed $raw): ?int {
    $value = is_array($raw) ? ($raw['value'] ?? NULL) : $raw;
    if (!is_numeric($value)) {
      return NULL;
    }

    return max(0, min(100, (int) round((float) $value)));
  }

  /**
   * Validates one configured coordinate.
   *
   * Empty and out-of-range both return NULL, which switches the forecast
   * off. Notably, a blank field must NOT read as 0.0: 0,0 is a valid point
   * in the Gulf of Guinea, and NWS would answer for it.
   */
  protected function coordinate(string $raw, float $limit): ?float {
    $raw = trim($raw);
    if ($raw === '' || !is_numeric($raw)) {
      return NULL;
    }
    $value = (float) $raw;

    return abs($value) <= $limit ? $value : NULL;
  }

  /**
   * Whole days from today to $day, in the site timezone.
   */
  protected function daysFromToday(string $today, string $day, \DateTimeZone $timezone): int {
    try {
      $from = new \DateTimeImmutable($today, $timezone);
      $to = new \DateTimeImmutable($day, $timezone);
    }
    catch (\Exception) {
      return PHP_INT_MAX;
    }
    $diff = $from->diff($to);

    return $diff->invert ? -1 : (int) $diff->days;
  }

  /**
   * Parses an NWS ISO-8601 timestamp into the site timezone.
   */
  protected function localTime(string $iso, \DateTimeZone $timezone): ?\DateTimeImmutable {
    if ($iso === '') {
      return NULL;
    }
    try {
      return (new \DateTimeImmutable($iso))->setTimezone($timezone);
    }
    catch (\Exception) {
      return NULL;
    }
  }

}
