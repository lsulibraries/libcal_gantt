<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt\Form;

use Drupal\Core\Cache\CacheTagsInvalidatorInterface;
use Drupal\Core\Form\ConfigFormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\libcal_gantt\Service\LibCalClient;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Admin form: /admin/config/services/libcal-gantt.
 */
class SettingsForm extends ConfigFormBase {

  protected CacheTagsInvalidatorInterface $cacheTagsInvalidator;

  public static function create(ContainerInterface $container): static {
    /** @var static $instance */
    $instance = parent::create($container);
    $instance->cacheTagsInvalidator = $container->get('cache_tags.invalidator');
    return $instance;
  }

  protected function getEditableConfigNames(): array {
    return ['libcal_gantt.settings'];
  }

  public function getFormId(): string {
    return 'libcal_gantt_settings_form';
  }

  public function buildForm(array $form, FormStateInterface $form_state): array {
    $config = $this->config('libcal_gantt.settings');

    $form['api'] = [
      '#type' => 'details',
      '#title' => $this->t('Springshare / LibCal API'),
      '#open' => TRUE,
    ];

    $form['api']['host'] = [
      '#type' => 'url',
      '#title' => $this->t('LibCal host'),
      '#default_value' => $config->get('host'),
      '#description' => $this->t('Your LibCal instance base URL, e.g. https://yourlibrary.libcal.com (no trailing slash).'),
      '#required' => TRUE,
    ];

    $form['api']['client_id'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Client ID'),
      '#default_value' => $config->get('client_id'),
      '#description' => $this->t('From LibCal Admin > API > API Authentication > Create New Application. Grant the application read access to Events.'),
      '#required' => TRUE,
    ];

    $form['api']['client_secret'] = [
      '#type' => 'password',
      '#title' => $this->t('Client secret'),
      '#description' => $config->get('client_secret')
        ? $this->t('A secret is currently stored. Leave blank to keep it. For production, consider moving this to the Key module rather than plain site configuration.')
        : $this->t('For production, consider storing this via the Key module rather than plain site configuration.'),
    ];

    $form['api']['calendars'] = [
      '#type' => 'textarea',
      '#rows' => 3,
      '#title' => $this->t('Calendars'),
      '#default_value' => $config->get('calendars') ?: "8030|Events\n16219|Library Displays",
      '#description' => $this->t('One calendar per line, as "calendar ID[,ID...]|Tab label" - e.g. "8030|Events" or "8030,8031|Combined View" to merge several LibCal calendars into one tab. Each line becomes its own switchable tab above the chart, in the order listed here - the first line is shown by default. Calendar IDs come from LibCal Admin > Calendars. If you only ever want one combined view with no tabs at all, just list a single line here.'),
      '#required' => TRUE,
    ];

    $form['display'] = [
      '#type' => 'details',
      '#title' => $this->t('Display window'),
      '#open' => TRUE,
    ];

    $form['display']['weekday_count'] = [
      '#type' => 'number',
      '#title' => $this->t('Number of weekdays to display'),
      '#default_value' => $config->get('weekday_count') ?: 10,
      '#min' => 1,
      '#max' => 30,
    ];

    $form['display']['day_start_hour'] = [
      '#type' => 'number',
      '#title' => $this->t('Day starts at (24h)'),
      '#default_value' => $config->get('day_start_hour') ?? 8,
      '#min' => 0,
      '#max' => 23,
      '#description' => $this->t('The display window each day column covers - events (or portions of events) outside it are clipped, and it\'s also the baseline the "Opens at"/"Closes at" hours captions compare against (see "Hours feed URL" below). Typically your earliest building opening hour.'),
    ];

    $form['display']['day_end_hour'] = [
      '#type' => 'number',
      '#title' => $this->t('Day ends at (24h)'),
      '#default_value' => $config->get('day_end_hour') ?? 21,
      '#min' => 1,
      '#max' => 24,
    ];

    $form['display']['timezone'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Timezone'),
      '#default_value' => $config->get('timezone'),
      '#description' => $this->t('PHP timezone identifier, e.g. America/Chicago. Leave blank to use the site default (%default).', [
        '%default' => $this->config('system.date')->get('timezone.default'),
      ]),
    ];

    $form['display']['campus_rows'] = [
      '#type' => 'textarea',
      '#rows' => 4,
      '#title' => $this->t('Location rows'),
      '#default_value' => $config->get('campus_rows') ?: "261|Main Library\n262|Hill Memorial Library",
      '#description' => $this->t('One row per line, as "campus ID|Row label" - e.g. "261|Main Library". The campus ID comes from each event\'s LibCal campus assignment (Admin > Calendars, or visible in a raw API response as campus.id) - NOT the location/room ID. This is a fixed allowlist: only events belonging to one of these campuses, or detected as an online event (see below), are shown on the chart at all; anything else is left off entirely rather than dumped into a generic row. Rows appear on the chart with the online-events row always first, followed by these campus rows in the order listed here. Save this field first, then a dedicated Hours feed URL field for each row listed here will appear in "Building hours" below.'),
      '#required' => TRUE,
    ];

    $form['display']['online_row_label'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Online events row label'),
      '#default_value' => $config->get('online_row_label') ?: 'Online Event',
      '#description' => $this->t('Row label for online/virtual events. Always appears first, ahead of the location rows above.'),
      '#required' => TRUE,
    ];

    $form['display']['online_location_keywords'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Online location keywords (fallback)'),
      '#default_value' => $config->get('online_location_keywords') ?: 'online,virtual',
      '#description' => $this->t('Events set up with LibCal\'s own "Online Event" meeting integration (Zoom, Teams, etc.) are always detected automatically - no configuration needed for those, even when their location field is blank, which is normal for them. This keyword list is only a fallback for events that are online WITHOUT using that integration - e.g. a location literally named "Online" or "Zoom." Comma-separated, case-insensitive, matched as a substring against the location text. Leave blank to disable the fallback and rely only on LibCal\'s own online-meeting fields.'),
    ];

    $form['hours'] = [
      '#type' => 'details',
      '#title' => $this->t('Building hours (optional)'),
      '#open' => (bool) $config->get('hours_feed_url') || (bool) array_filter((array) $config->get('campus_hours_feed_urls')),
      '#description' => $this->t('Shows each location\'s open/close times as small captions on the grid ("Opens 7:00 AM" above the day\'s events, "Closes 9:00 PM" below them, or "Closed" for the whole day), and as a text line per location in the mobile agenda. This uses a different part of LibCal than Events above: a public JSON feed you generate yourself, not the OAuth API.'),
    ];

    $form['hours']['hours_feed_url'] = [
      '#type' => 'url',
      '#title' => $this->t('Hours feed URL (default)'),
      '#default_value' => $config->get('hours_feed_url'),
      '#description' => $this->t('In LibCal, go to Admin > Hours > Widgets > Weekly Data, set "# Weeks to Show" high enough to cover this chart plus a few "show more" clicks (e.g. 6), choose JSON as the format, click Generate Code/Preview, and paste the resulting URL here. This is the fallback used by any row below that doesn\'t have its own feed URL set - on a single-building site, setting just this one field covers every row. Leave blank (and leave every row\'s own feed URL blank too) to hide hours entirely. Note: LibCal commonly bundles every building into ONE feed response rather than giving each its own URL - if that\'s the case here, every row below will end up using this same URL, and each row\'s "Location ID (lid)" field (not its own separate URL) is what tells them apart. LibCal has changed this widget\'s exact JSON field names across versions, so double-check the hours look right against a real day once this is set - see the module README for how to adjust field-name parsing if needed.'),
    ];

    // One dedicated URL + lid field pair per row currently configured in
    // "Location rows" above, so a multi-building site can give each row
    // its own Hours feed without cramming a URL into that textarea.
    // Generated dynamically from the saved campus_rows config (not the
    // form's current, possibly-unsaved textarea value) - editing
    // "Location rows" and saving is what adds/removes a row's fields
    // here.
    $campusRows = LibCalClient::parseCampusRows((string) $config->get('campus_rows'));
    if ($campusRows) {
      $form['hours']['campus_hours_feed_urls'] = [
        '#type' => 'container',
        '#tree' => TRUE,
      ];
      $form['hours']['campus_hours_lids'] = [
        '#type' => 'container',
        '#tree' => TRUE,
      ];
      foreach ($campusRows as $campusId => $label) {
        $form['hours']['campus_hours_feed_urls'][$campusId] = [
          '#type' => 'url',
          '#title' => $this->t('Hours feed URL for @label', ['@label' => $label]),
          '#default_value' => $config->get('campus_hours_feed_urls.' . $campusId),
          '#description' => $this->t('Optional - only needed if @label\'s feed is a genuinely different URL than the site-wide default above. Most LibCal sites can leave this blank and just set "Location ID (lid)" below instead - see its description.'),
        ];
        $form['hours']['campus_hours_lids'][$campusId] = [
          '#type' => 'number',
          '#title' => $this->t('Location ID (lid) for @label', ['@label' => $label]),
          '#default_value' => $config->get('campus_hours_lids.' . $campusId),
          '#min' => 1,
          '#description' => $this->t('Only needed if the Hours feed URL this row uses (its own above, or the site-wide default) returns MULTIPLE buildings in one response - open the feed URL directly in a browser and look for a top-level "locations" array; if you see one, each entry has an "lid" number and a "name" - enter @label\'s lid here so its hours aren\'t mixed up with another building\'s. Leave blank if the feed only ever returns one location (no "locations" wrapper).', ['@label' => $label]),
        ];
      }
    }

    $form['hours']['hours_cache_ttl'] = [
      '#type' => 'number',
      '#title' => $this->t('Hours cache lifetime (seconds)'),
      '#default_value' => $config->get('hours_cache_ttl') ?: 3600,
      '#min' => 60,
      '#description' => $this->t('Hours change far less often than events, so this defaults to a much longer cache than the events cache above.'),
    ];

    $form['advanced'] = [
      '#type' => 'details',
      '#title' => $this->t('Advanced'),
    ];

    $form['advanced']['event_limit'] = [
      '#type' => 'number',
      '#title' => $this->t('Max events per calendar request'),
      '#default_value' => $config->get('event_limit') ?: 100,
      '#min' => 1,
    ];

    $form['advanced']['cache_ttl'] = [
      '#type' => 'number',
      '#title' => $this->t('Cache lifetime (seconds)'),
      '#default_value' => $config->get('cache_ttl') ?: 900,
      '#min' => 60,
      '#description' => $this->t('How long fetched events are cached before LibCal is queried again.'),
    ];

    return parent::buildForm($form, $form_state);
  }

  public function submitForm(array &$form, FormStateInterface $form_state): void {
    $config = $this->config('libcal_gantt.settings');

    $config
      ->set('host', rtrim((string) $form_state->getValue('host'), '/'))
      ->set('client_id', (string) $form_state->getValue('client_id'))
      ->set('calendars', (string) $form_state->getValue('calendars'))
      ->set('weekday_count', (int) $form_state->getValue('weekday_count'))
      ->set('event_limit', (int) $form_state->getValue('event_limit'))
      ->set('cache_ttl', (int) $form_state->getValue('cache_ttl'))
      ->set('timezone', (string) $form_state->getValue('timezone'))
      ->set('day_start_hour', (int) $form_state->getValue('day_start_hour'))
      ->set('day_end_hour', (int) $form_state->getValue('day_end_hour'))
      ->set('hours_feed_url', trim((string) $form_state->getValue('hours_feed_url')))
      ->set('hours_cache_ttl', (int) $form_state->getValue('hours_cache_ttl'))
      ->set('campus_rows', (string) $form_state->getValue('campus_rows'))
      ->set('online_row_label', trim((string) $form_state->getValue('online_row_label')))
      ->set('online_location_keywords', (string) $form_state->getValue('online_location_keywords'));

    // Only the per-row URL fields that were actually rendered (i.e. rows
    // currently in "Location rows") are in $form_state - trim and drop
    // blanks so config doesn't accumulate stale entries for rows that get
    // renamed or removed later.
    $campusHoursFeedUrls = [];
    foreach ((array) $form_state->getValue('campus_hours_feed_urls', []) as $campusId => $url) {
      $url = trim((string) $url);
      if ($url !== '') {
        $campusHoursFeedUrls[(int) $campusId] = $url;
      }
    }
    $config->set('campus_hours_feed_urls', $campusHoursFeedUrls);

    // Same treatment for the per-row lid fields - only non-blank, valid
    // (>0) values are kept.
    $campusHoursLids = [];
    foreach ((array) $form_state->getValue('campus_hours_lids', []) as $campusId => $lid) {
      $lid = trim((string) $lid);
      if ($lid !== '' && (int) $lid > 0) {
        $campusHoursLids[(int) $campusId] = (int) $lid;
      }
    }
    $config->set('campus_hours_lids', $campusHoursLids);

    $secret = $form_state->getValue('client_secret');
    if ($secret !== '' && $secret !== NULL) {
      $config->set('client_secret', (string) $secret);
    }

    $config->save();

    // Credentials or the display window changed - drop any cached token
    // and event lists so the new settings take effect immediately rather
    // than waiting out the old cache TTL.
    $this->cacheTagsInvalidator->invalidateTags([LibCalClient::CACHE_TAG]);

    parent::submitForm($form, $form_state);
  }

}