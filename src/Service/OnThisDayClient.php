<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt\Service;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Component\Utility\Html;
use Drupal\Core\Cache\CacheBackendInterface;
use Drupal\Core\Config\ConfigFactoryInterface;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Promise\Utils;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\LoggerInterface;

/**
 * Server-side client for Wikipedia's "On this day" (selected anniversaries).
 *
 * Fills the homepage day cards that would otherwise say only "Nothing
 * scheduled" with one anniversary from that card's calendar date.
 *
 * WHY SERVER-SIDE rather than a fetch() from the browser: the same reasons
 * the weather lives here. Every visitor's browser would otherwise call a
 * third-party host on every homepage view (a privacy question the library
 * would have to answer, and a Content-Security-Policy connect-src entry the
 * theme would have to carry), and Wikimedia asks automated callers to send
 * an identifying User-Agent, which a browser cannot set. Here, one request
 * per calendar date is shared by every visitor for the cache lifetime.
 *
 * WHY "SELECTED" and not "events": `selected` is the short, editor-curated
 * list that appears in the "On this day" box on Wikipedia's Main Page -
 * typically five to twenty items. `events` is every dated event Wikipedia
 * knows for the date, hundreds of them, far less curated and much more
 * likely to put something grim on the library homepage.
 *
 * THE RANDOM PICK IS NOT MADE HERE. The whole list for a date is returned
 * and cached; the front end chooses one per page load (see
 * pickOnThisDayFact() in gantt-timeline.js). Picking here would mean one
 * fact per cache lifetime for everybody, which is not what "a random one
 * on each page load" asks for.
 *
 * EVERYTHING FAILS SOFT, exactly like WeatherClient: a disabled setting, a
 * Wikimedia outage, a changed response shape - all end with no entry for
 * that day, and the card renders "Nothing scheduled" on its own as it
 * always has.
 *
 * @see \Drupal\libcal_gantt\Controller\GanttEventsController::getEvents()
 */
class OnThisDayClient {

  /**
   * Shares LibCalClient's cache tag so one settings change clears both.
   */
  public const CACHE_TAG = LibCalClient::CACHE_TAG;

  /**
   * Endpoints tried in order; both return the same JSON shape.
   *
   * The en.wikipedia.org REST feed is the long-standing public one. The
   * api.wikimedia.org mirror is only asked for dates the first one failed
   * to answer, so a problem with either host alone does not empty the
   * cards. `%s` is replaced with MM/DD.
   */
  protected const ENDPOINTS = [
    'https://en.wikipedia.org/api/rest_v1/feed/onthisday/selected/%s',
    'https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/selected/%s',
  ];

  /**
   * How long a failed or empty lookup is remembered, in seconds.
   *
   * Short on purpose: long enough that an outage costs one request per date
   * per hour rather than one per page view, short enough that the cards
   * fill back in soon after Wikimedia does.
   */
  protected const FAILURE_TTL = 3600;

  /**
   * Facts longer than this are dropped when shorter ones exist.
   *
   * A day card is a fifth of the block wide. An anniversary that needs
   * five lines there makes its card the tallest in the row, and the whole
   * row grows to match - pushing everything below it further down the
   * homepage for the sake of filler. If every fact for a date is long, the
   * long ones are kept rather than showing nothing; the card clamps them.
   */
  protected const PREFERRED_MAX_LENGTH = 200;

  /**
   * Upper bound on facts kept per date, so the payload stays small.
   */
  protected const MAX_FACTS_PER_DAY = 20;

  public function __construct(
    protected readonly ClientInterface $httpClient,
    protected readonly ConfigFactoryInterface $configFactory,
    protected readonly CacheBackendInterface $cache,
    protected readonly TimeInterface $time,
    protected readonly LoggerInterface $logger,
  ) {}

  /**
   * Returns the anniversaries for each requested day.
   *
   * @param array<int, string> $days
   *   Y-m-d strings. Only the month and day are used - "on this day" is a
   *   calendar date, not a particular year's date.
   *
   * @return array<string, array<int, array<string, mixed>>>
   *   Keyed by Y-m-d; days with nothing usable are absent. Each fact has
   *   `year` (int|null; negative for BC), `text` (plain text, never HTML),
   *   `title` (the linked article's title) and `url` (an https Wikipedia
   *   article URL).
   */
  public function getFacts(array $days): array {
    $config = $this->configFactory->get('libcal_gantt.settings');
    if (!$config->get('show_on_this_day') || !$days) {
      return [];
    }
    $ttl = max(3600, (int) ($config->get('on_this_day_cache_ttl') ?: 86400));

    // Keyed by MM/DD, because that is what the feed and the cache are keyed
    // by: an anniversary list belongs to a calendar date in every year.
    $dayByMonthDay = [];
    foreach ($days as $day) {
      $date = \DateTimeImmutable::createFromFormat('!Y-m-d', (string) $day);
      if ($date) {
        $dayByMonthDay[$date->format('m/d')][] = (string) $day;
      }
    }

    $factsByMonthDay = [];
    $missing = [];
    foreach (array_keys($dayByMonthDay) as $monthDay) {
      $cached = $this->cache->get($this->cacheId($monthDay));
      if ($cached) {
        $factsByMonthDay[$monthDay] = $cached->data;
      }
      else {
        $missing[] = $monthDay;
      }
    }

    // Cold cache: every missing date is requested IN PARALLEL, so a first
    // load after a cache clear costs one round trip rather than one per
    // quiet day. Each endpoint is only asked for what the previous one
    // failed to deliver.
    foreach (self::ENDPOINTS as $endpoint) {
      if (!$missing) {
        break;
      }
      $fetched = $this->fetchMany($endpoint, $missing);
      foreach ($fetched as $monthDay => $facts) {
        $factsByMonthDay[$monthDay] = $facts;
        $this->cache->set($this->cacheId($monthDay), $facts, $this->time->getRequestTime() + $ttl, [self::CACHE_TAG]);
      }
      $missing = array_values(array_diff($missing, array_keys($fetched)));
    }

    foreach ($missing as $monthDay) {
      $factsByMonthDay[$monthDay] = [];
      $this->cache->set($this->cacheId($monthDay), [], $this->time->getRequestTime() + self::FAILURE_TTL, [self::CACHE_TAG]);
    }

    $result = [];
    foreach ($dayByMonthDay as $monthDay => $dayKeys) {
      if (empty($factsByMonthDay[$monthDay])) {
        continue;
      }
      foreach ($dayKeys as $dayKey) {
        $result[$dayKey] = $factsByMonthDay[$monthDay];
      }
    }
    return $result;
  }

  /**
   * Requests several dates from one endpoint concurrently.
   *
   * @return array<string, array<int, array<string, mixed>>>
   *   Keyed by MM/DD, containing only the dates that returned at least one
   *   usable fact.
   */
  protected function fetchMany(string $endpoint, array $monthDays): array {
    $promises = [];
    foreach ($monthDays as $monthDay) {
      $promises[$monthDay] = $this->httpClient->requestAsync('GET', sprintf($endpoint, $monthDay), [
        'headers' => [
          'Accept' => 'application/json',
          'User-Agent' => $this->userAgent(),
        ],
        // Short, like the weather: filler must never be what makes the
        // events endpoint feel slow.
        'timeout' => 5,
        'connect_timeout' => 3,
      ]);
    }

    $results = [];
    try {
      $settled = Utils::settle($promises)->wait();
    }
    catch (\Throwable $e) {
      $this->logger->warning('LibCal Gantt: "On this day" requests failed: @message', ['@message' => $e->getMessage()]);
      return [];
    }
    foreach ($settled as $monthDay => $outcome) {
      if (($outcome['state'] ?? '') !== 'fulfilled' || !$outcome['value'] instanceof ResponseInterface) {
        $reason = $outcome['reason'] ?? NULL;
        $this->logger->warning('LibCal Gantt: "On this day" request failed (@url): @message', [
          '@url' => sprintf($endpoint, $monthDay),
          '@message' => $reason instanceof \Throwable ? $reason->getMessage() : 'unknown error',
        ]);
        continue;
      }
      $data = json_decode((string) $outcome['value']->getBody(), TRUE);
      $facts = $this->normalize(is_array($data) ? ($data['selected'] ?? []) : [], (string) $monthDay);
      if ($facts) {
        $results[$monthDay] = $facts;
      }
    }
    return $results;
  }

  /**
   * Reduces Wikimedia's records to the four fields the card draws.
   *
   * `text` is treated as untrusted even though the feed documents it as
   * plain text: tags are stripped and entities decoded here, and the front
   * end still writes it with textContent. The link is only kept when it is
   * an https Wikipedia URL, and otherwise falls back to that date's
   * Selected anniversaries page, so the card can never be made to link
   * somewhere else.
   */
  protected function normalize($records, string $monthDay): array {
    if (!is_array($records)) {
      return [];
    }

    $fallbackUrl = $this->anniversariesUrl($monthDay);
    $facts = [];
    foreach ($records as $record) {
      if (!is_array($record)) {
        continue;
      }
      $text = trim(preg_replace('/\s+/u', ' ', Html::decodeEntities(strip_tags((string) ($record['text'] ?? '')))) ?? '');
      if ($text === '') {
        continue;
      }

      $page = is_array($record['pages'][0] ?? NULL) ? $record['pages'][0] : [];
      $url = (string) ($page['content_urls']['desktop']['page'] ?? '');
      if (!preg_match('#^https://en\.wikipedia\.org/wiki/#', $url)) {
        $url = $fallbackUrl;
      }
      $title = trim((string) ($page['titles']['normalized'] ?? $page['normalizedtitle'] ?? ''));

      $facts[] = [
        'year' => isset($record['year']) && is_numeric($record['year']) ? (int) $record['year'] : NULL,
        'text' => $text,
        'title' => $title,
        'url' => $url,
      ];
    }

    $short = array_values(array_filter($facts, static fn (array $fact): bool => mb_strlen($fact['text']) <= self::PREFERRED_MAX_LENGTH));
    return array_slice($short ?: $facts, 0, self::MAX_FACTS_PER_DAY);
  }

  /**
   * Wikipedia's human-readable page for one date's selected anniversaries.
   */
  protected function anniversariesUrl(string $monthDay): string {
    $date = \DateTimeImmutable::createFromFormat('!m/d', $monthDay);
    return 'https://en.wikipedia.org/wiki/Wikipedia:Selected_anniversaries/' . ($date ? $date->format('F_j') : '');
  }

  protected function cacheId(string $monthDay): string {
    return 'libcal_gantt:onthisday:en:selected:' . str_replace('/', '-', $monthDay);
  }

  /**
   * Builds the identifying User-Agent Wikimedia's API policy asks for.
   *
   * Uses the site email as the contact, the same fallback WeatherClient
   * uses when its own contact field is blank.
   */
  protected function userAgent(): string {
    $contact = trim((string) $this->configFactory->get('system.site')->get('mail'));
    return 'Drupal libcal_gantt (https://github.com/lsulibraries/libcal_gantt' . ($contact !== '' ? '; ' . $contact : '') . ')';
  }

}
