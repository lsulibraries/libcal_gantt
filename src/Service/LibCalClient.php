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
 * Thin server-side client for the Springshare LibCal REST API (v1.1).
 *
 * All calls to LibCal happen here, never in the browser, so the client
 * secret and OAuth access token never leave the server. The controller
 * that serves the front-end only ever talks to Drupal's own
 * /libcal-gantt/events route.
 */
class LibCalClient {

  /**
   * Cache tag applied to every item this service writes, so settings
   * changes can invalidate everything in one call.
   */
  public const CACHE_TAG = 'libcal_gantt';

  public function __construct(
    protected readonly ClientInterface $httpClient,
    protected readonly ConfigFactoryInterface $configFactory,
    protected readonly CacheBackendInterface $cache,
    protected readonly TimeInterface $time,
    protected readonly LoggerInterface $logger,
  ) {}

  /**
   * Fetches events for a set of LibCal calendar IDs within a date window.
   *
   * The module supports multiple independently-switchable "calendars" on
   * the front end (see the `calendars` setting / LibCalClient::
   * parseCalendars()) - each one is a tab the visitor can pick, backed by
   * one or more LibCal calendar IDs merged together. Which IDs to fetch
   * is therefore the caller's decision (GanttEventsController resolves
   * the requested/default tab and passes its IDs here) rather than this
   * method reading a single site-wide list from config itself.
   *
   * @param array<int, int|string> $calendarIds
   *   The LibCal calendar ID(s) to fetch and merge, e.g. from one
   *   `calendars` config line - usually one ID, but a tab can combine
   *   several.
   * @param string $dateStart
   *   The first date to request, in Y-m-d format.
   * @param int $days
   *   How many consecutive calendar days (including $dateStart) to
   *   request from LibCal. This is a calendar-day span; weekday
   *   filtering happens afterwards in the controller.
   *
   * @return array<int, array<string, mixed>>
   *   Raw (un-normalized) event arrays as returned by LibCal, merged
   *   across the given calendar IDs and sorted by start time.
   */
  public function getUpcomingEvents(array $calendarIds, string $dateStart, int $days): array {
    if (empty($calendarIds)) {
      $this->logger->warning('LibCal Gantt: no calendar IDs configured.');
      return [];
    }

    $config = $this->configFactory->get('libcal_gantt.settings');
    $cacheId = 'libcal_gantt:events:' . implode(',', $calendarIds) . ':' . $dateStart . ':' . $days;

    if ($cached = $this->cache->get($cacheId)) {
      return $cached->data;
    }

    $token = $this->getAccessToken();
    if (!$token) {
      return [];
    }

    $host = $this->getHost();
    $limit = (int) ($config->get('event_limit') ?: 100);
    $allEvents = [];

    foreach ($calendarIds as $calendarId) {
      try {
        $response = $this->httpClient->request('GET', $host . '/1.1/events', [
          'headers' => [
            'Authorization' => 'Bearer ' . $token,
            'Accept' => 'application/json',
          ],
          'query' => [
            'cal_id' => $calendarId,
            'date' => $dateStart,
            'days' => $days,
            'limit' => $limit,
          ],
          'timeout' => 10,
        ]);

        $body = json_decode((string) $response->getBody(), TRUE);
        // LibCal has historically returned either {"events": [...]} or a
        // bare array depending on endpoint/version; handle both.
        $events = $body['events'] ?? (is_array($body) ? $body : []);
        foreach ($events as $event) {
          if (is_array($event)) {
            $allEvents[] = $event;
          }
        }
      }
      catch (GuzzleException $e) {
        $this->logger->error('LibCal Gantt: events request failed for calendar @cal_id: @message', [
          '@cal_id' => $calendarId,
          '@message' => $e->getMessage(),
        ]);
      }
    }

    usort($allEvents, static fn (array $a, array $b): int =>
      strcmp((string) ($a['start'] ?? ''), (string) ($b['start'] ?? ''))
    );

    $ttl = (int) ($config->get('cache_ttl') ?: 900);
    $this->cache->set($cacheId, $allEvents, $this->time->getRequestTime() + $ttl, [self::CACHE_TAG]);

    return $allEvents;
  }

  /**
   * Returns a cached OAuth access token, requesting a new one if needed.
   */
  protected function getAccessToken(): ?string {
    $cacheId = 'libcal_gantt:access_token';
    if ($cached = $this->cache->get($cacheId)) {
      return $cached->data;
    }

    $config = $this->configFactory->get('libcal_gantt.settings');
    $clientId = (string) $config->get('client_id');
    $clientSecret = (string) $config->get('client_secret');
    $host = $this->getHost();

    if (!$host || !$clientId || !$clientSecret) {
      $this->logger->error('LibCal Gantt: host, client ID, or client secret is not configured.');
      return NULL;
    }

    try {
      $response = $this->httpClient->request('POST', $host . '/1.1/oauth/token', [
        'form_params' => [
          'client_id' => $clientId,
          'client_secret' => $clientSecret,
          'grant_type' => 'client_credentials',
        ],
        'timeout' => 10,
      ]);

      $data = json_decode((string) $response->getBody(), TRUE);
      $token = $data['access_token'] ?? NULL;

      if (!$token) {
        $this->logger->error('LibCal Gantt: token response did not include an access_token.');
        return NULL;
      }

      $expiresIn = (int) ($data['expires_in'] ?? 3600);
      // Refresh a minute early so we never serve an expired token.
      $expire = $this->time->getRequestTime() + max(60, $expiresIn - 60);
      $this->cache->set($cacheId, $token, $expire, [self::CACHE_TAG]);

      return $token;
    }
    catch (GuzzleException $e) {
      $this->logger->error('LibCal Gantt: failed to obtain an OAuth token: @message', [
        '@message' => $e->getMessage(),
      ]);
      return NULL;
    }
  }

  /**
   * Fetches the raw JSON payload from a Hours feed URL.
   *
   * Unlike events, LibCal building/location hours aren't part of the
   * OAuth-protected REST API - they come from the public "Hours" widget
   * feed each institution generates from its own LibCal Admin > Hours >
   * Widgets screen (Weekly Data, JSON format). That means no token is
   * needed here, but it also means the response shape isn't something
   * this module can rely on a single documented schema for; parsing it
   * happens defensively in GanttEventsController.
   *
   * The URL is a parameter, not read from config here, because a site
   * with multiple location rows can configure a separate Hours feed per
   * row (see "Location rows" in the settings form) - the controller
   * resolves which URL applies to which row and may call this once per
   * distinct feed. Each URL is cached independently below, so calling
   * this for the same feed URL from multiple rows (e.g. two rows both
   * falling back to the site-wide default) still only hits LibCal once.
   *
   * @param string $feedUrl
   *   The Hours widget feed URL to fetch. An empty string short-circuits
   *   to an empty result without making a request.
   *
   * @return array<mixed>
   *   The decoded JSON payload, or an empty array if no feed URL was
   *   given or the request fails.
   */
  public function getHours(string $feedUrl): array {
    $feedUrl = trim($feedUrl);
    if ($feedUrl === '') {
      return [];
    }

    $config = $this->configFactory->get('libcal_gantt.settings');
    $cacheId = 'libcal_gantt:hours:' . md5($feedUrl);
    if ($cached = $this->cache->get($cacheId)) {
      return $cached->data;
    }

    try {
      $response = $this->httpClient->request('GET', $feedUrl, [
        'headers' => ['Accept' => 'application/json'],
        'timeout' => 10,
      ]);
      $data = json_decode((string) $response->getBody(), TRUE);
      $data = is_array($data) ? $data : [];
    }
    catch (GuzzleException $e) {
      $this->logger->error('LibCal Gantt: hours feed request failed: @message', [
        '@message' => $e->getMessage(),
      ]);
      return [];
    }

    // Hours change far less often than events - default to a much longer
    // cache lifetime, configurable separately from the events cache TTL.
    $ttl = (int) ($config->get('hours_cache_ttl') ?: 3600);
    $this->cache->set($cacheId, $data, $this->time->getRequestTime() + $ttl, [self::CACHE_TAG]);

    return $data;
  }

  protected function getHost(): string {
    return rtrim((string) $this->configFactory->get('libcal_gantt.settings')->get('host'), '/');
  }

  /**
   * Parses the "Location rows" admin setting into an ordered `campus ID
   * => label` map.
   *
   * Format is one row per line, "<campus ID>|<label>" - e.g.
   * "261|Main Library". The campus ID is LibCal's `campus.id` field on
   * each event (visible in LibCal Admin, or in a raw API response - it's
   * the library/branch a calendar's events belong to), which is a far
   * more reliable grouping signal than the free-text `location` field (a
   * specific room, often blank for online events). Malformed or blank
   * lines are skipped rather than erroring, so a stray blank line in the
   * textarea doesn't take down the whole chart.
   *
   * Shared between GanttEventsController (to filter/group events) and
   * SettingsForm (to know which per-row Hours feed URL fields to render)
   * so both stay in exact agreement about what a row is, without either
   * duplicating the parsing rules or reaching into the other's internals.
   *
   * @return array<int, string>
   *   Ordered (insertion-order-preserved) map of campus ID to row label.
   */
  /**
   * Parses the "Calendars" admin setting into an ordered list of
   * switchable calendar tabs.
   *
   * Format is one tab per line, "<calendar ID>[,<calendar ID>...]|<tab
   * label>" - e.g. "8030|Events" or "8030,8031|Combined View". Multiple
   * comma-separated IDs on one line are merged into a single tab (same
   * merge behavior the old single `calendar_ids` setting used for
   * everything); most sites will just have one ID per line. Malformed or
   * blank lines are skipped rather than erroring.
   *
   * Each tab is keyed by its first calendar ID (as a string) rather than
   * by an arbitrary slug - it's already unique per tab in practice, it's
   * stable even if the label is edited, and it's what the front end
   * round-trips back as the `?calendar=` query parameter when switching
   * tabs, mirroring how parseCampusRows() above keys rows by campus ID
   * rather than by label.
   *
   * @return array<string, array{label: string, ids: array<int, int>}>
   *   Ordered (insertion-order-preserved) map of tab key => {label, ids}.
   */
  public static function parseCalendars(string $raw): array {
    $calendars = [];
    foreach (preg_split('/\r\n|\r|\n/', $raw) ?: [] as $line) {
      $line = trim($line);
      if ($line === '' || !str_contains($line, '|')) {
        continue;
      }
      $parts = explode('|', $line, 2);
      $label = trim($parts[1] ?? '');
      $ids = array_values(array_unique(array_filter(array_map(
        static fn (string $id): int => (int) trim($id),
        explode(',', $parts[0])
      ), static fn (int $id): bool => $id > 0)));

      if ($ids && $label !== '') {
        $calendars[(string) $ids[0]] = ['label' => $label, 'ids' => $ids];
      }
    }
    return $calendars;
  }

  public static function parseCampusRows(string $raw): array {
    $rows = [];
    foreach (preg_split('/\r\n|\r|\n/', $raw) ?: [] as $line) {
      $line = trim($line);
      if ($line === '' || !str_contains($line, '|')) {
        continue;
      }
      $parts = explode('|', $line, 2);
      $id = (int) trim($parts[0]);
      $label = trim($parts[1] ?? '');
      if ($id > 0 && $label !== '') {
        $rows[$id] = $label;
      }
    }
    return $rows;
  }

}