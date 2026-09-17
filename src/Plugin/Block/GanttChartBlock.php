<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt\Plugin\Block;

use Drupal\Core\Block\Attribute\Block;
use Drupal\Core\Block\BlockBase;
use Drupal\Core\Cache\Cache;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Component\Utility\Html;
use Drupal\Core\Plugin\ContainerFactoryPluginInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Url;
use Drupal\libcal_gantt\Form\SettingsForm;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Provides the "LibCal Events Gantt Chart" block.
 *
 * Place this block in any region of your custom theme. It renders an
 * empty container plus the gantt-timeline library; the JavaScript fetches
 * /libcal-gantt/events and builds the chart client-side, so the block
 * itself stays cheap to render and cacheable.
 *
 * Two presentations are available per block instance, chosen with the
 * "Display style" setting:
 *
 *   - Full grid: the original wide weekday grid, with the mobile agenda
 *     fallback on narrow screens. Intended for a dedicated events page.
 *   - Homepage teaser: a compact row of day cards showing the next few
 *     days only, with a "Full calendar" link and a "Show more" control
 *     beside it. Intended for the LSU Libraries homepage, where the wide
 *     grid does not fit the surrounding three-column layout.
 *
 * The settings below are DISPLAY concerns and therefore live on the block
 * instance, not in libcal_gantt.settings: the same LibCal feed can then be
 * placed twice - once as a homepage teaser, once as a full grid on the
 * events page - without the two placements fighting over one global value.
 * Feed concerns (credentials, calendars, weekday count) stay in module
 * settings, because they are the same wherever the block is placed.
 */
#[Block(
  id: 'libcal_gantt_chart',
  admin_label: new TranslatableMarkup('LibCal Events Gantt Chart'),
)]
class GanttChartBlock extends BlockBase implements ContainerFactoryPluginInterface {

  /**
   * Config factory, for the site-wide "Full calendar" link target.
   *
   * That URL is deliberately NOT a block default: defaults are read only
   * when a block is FIRST placed, so an existing placement - which already
   * has an empty string saved against this key - would never consult a new
   * one. Reading the site setting at build time means the link can be
   * changed in one place and every placement that has not overridden it
   * picks the change up.
   */
  protected ConfigFactoryInterface $configFactory;

  public function __construct(array $configuration, $plugin_id, $plugin_definition, ConfigFactoryInterface $config_factory) {
    parent::__construct($configuration, $plugin_id, $plugin_definition);
    $this->configFactory = $config_factory;
  }

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
    return new static(
      $configuration,
      $plugin_id,
      $plugin_definition,
      $container->get('config.factory')
    );
  }

  /**
   * Returns the site-wide "Full calendar" URL, or '' if it is unset.
   */
  protected function siteFullCalendarUrl(): string {
    $configured = $this->configFactory->get('libcal_gantt.settings')->get('full_calendar_url');

    // NULL - as opposed to an empty string - means the site's saved config
    // predates this setting, so the shipped default stands in until
    // libcal_gantt_update_10003() seeds it. A deliberately emptied setting
    // stays empty and omits the link.
    return trim((string) ($configured ?? SettingsForm::DEFAULT_FULL_CALENDAR_URL));
  }

  /**
   * {@inheritdoc}
   *
   * Chosen so that an EXISTING placement, which has none of these keys
   * stored, keeps behaving exactly as it did before this setting existed:
   * the full grid, dark, no legend, no toggle.
   */
  public function defaultConfiguration(): array {
    return [
      'render_mode' => 'grid',
      'chart_title' => '',
      'homepage_days' => 3,
      'full_calendar_url' => '',
      'show_legend' => FALSE,
      'theme' => 'dark',
      'allow_theme_toggle' => FALSE,
    ] + parent::defaultConfiguration();
  }

  /**
   * {@inheritdoc}
   */
  public function blockForm($form, FormStateInterface $form_state): array {
    $config = $this->getConfiguration();

    $form['render_mode'] = [
      '#type' => 'radios',
      '#title' => $this->t('Display style'),
      '#default_value' => $config['render_mode'],
      '#options' => [
        'grid' => $this->t('Full grid - wide weekday timeline (dedicated events page)'),
        'homepage' => $this->t('Homepage teaser - compact day cards (homepage or sidebar)'),
      ],
      '#required' => TRUE,
    ];

    // Everything in this fieldset applies to the teaser only. The #states
    // handler hides it for the grid rather than the form silently
    // accepting values that would never be read.
    $form['homepage'] = [
      '#type' => 'details',
      '#title' => $this->t('Homepage teaser options'),
      '#open' => $config['render_mode'] === 'homepage',
      '#states' => [
        'visible' => [
          ':input[name="settings[render_mode]"]' => ['value' => 'homepage'],
        ],
      ],
    ];

    $form['homepage']['chart_title'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Heading'),
      '#default_value' => $config['chart_title'],
      '#maxlength' => 128,
      '#description' => $this->t('Shown above the day cards. Leave empty to render no heading - useful when the surrounding page layout already provides a section title.'),
    ];

    $form['homepage']['homepage_days'] = [
      '#type' => 'number',
      '#title' => $this->t('Days shown'),
      '#default_value' => $config['homepage_days'],
      '#min' => 1,
      '#max' => 14,
      '#description' => $this->t('How many days are visible before "Show more" is used. Each click then reveals the rest of that week plus the following one, so the cards always fill complete rows. Weekend days are grouped into a single strip and do not count toward this number.'),
    ];

    $siteUrl = $this->siteFullCalendarUrl();
    $form['homepage']['full_calendar_url'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Full calendar URL'),
      '#default_value' => $config['full_calendar_url'],
      '#maxlength' => 255,
      // The inherited value is spelled out rather than merely referred to,
      // so an editor can see what an empty field will actually link to
      // without opening the module settings form in another tab.
      '#description' => $siteUrl !== ''
        ? $this->t('Override the "Full calendar" link for this placement only, e.g. /events. Leave empty - the recommended setting - to inherit the site-wide URL, currently @url, from the <a href=":settings" target="_blank">module settings form</a>.', [
          '@url' => $siteUrl,
          ':settings' => Url::fromRoute('libcal_gantt.settings')->toString(),
        ])
        : $this->t('Target of the "Full calendar" link, e.g. /events or https://lsu.libcal.com/calendar/eventsandprogramming. No site-wide URL is set on the <a href=":settings" target="_blank">module settings form</a>, so leaving this empty omits the link entirely.', [
          ':settings' => Url::fromRoute('libcal_gantt.settings')->toString(),
        ]),
    ];

    $form['appearance'] = [
      '#type' => 'details',
      '#title' => $this->t('Appearance'),
      '#open' => TRUE,
    ];

    $form['appearance']['show_legend'] = [
      '#type' => 'checkbox',
      '#title' => $this->t('Show legend'),
      '#default_value' => $config['show_legend'],
      '#description' => $this->t('Renders a key below the chart explaining the event, all-day, today and open/closed styling. The legend is rendered outside the chart itself, so a swatch can never be mistaken for a real event.'),
    ];

    $form['appearance']['theme'] = [
      '#type' => 'select',
      '#title' => $this->t('Theme'),
      '#default_value' => $config['theme'],
      '#options' => [
        'dark' => $this->t('Dark (default)'),
        'light' => $this->t('Light'),
        'auto' => $this->t("Follow visitor's system preference"),
      ],
      '#description' => $this->t('The starting theme. If the visitor toggle below is enabled, a visitor’s own saved choice takes precedence over this setting.'),
    ];

    $form['appearance']['allow_theme_toggle'] = [
      '#type' => 'checkbox',
      '#title' => $this->t('Show light/dark toggle to visitors'),
      '#default_value' => $config['allow_theme_toggle'],
      '#description' => $this->t('Adds a small toggle button. The choice is remembered in the browser for return visits. Ignored in Homepage mode, which always uses the theme chosen above: that block is a panel inside a page whose colours it does not control, so a visitor-flipped light card would sit awkwardly on a dark banner.'),
    ];

    return $form;
  }

  /**
   * {@inheritdoc}
   */
  public function blockSubmit($form, FormStateInterface $form_state): void {
    // Nested values are read from the groups they were declared in.
    $this->configuration['render_mode'] = $form_state->getValue('render_mode');
    $this->configuration['chart_title'] = trim((string) $form_state->getValue(['homepage', 'chart_title']));
    $this->configuration['homepage_days'] = (int) $form_state->getValue(['homepage', 'homepage_days']);
    $this->configuration['full_calendar_url'] = trim((string) $form_state->getValue(['homepage', 'full_calendar_url']));
    $this->configuration['show_legend'] = (bool) $form_state->getValue(['appearance', 'show_legend']);
    $this->configuration['theme'] = $form_state->getValue(['appearance', 'theme']);
    $this->configuration['allow_theme_toggle'] = (bool) $form_state->getValue(['appearance', 'allow_theme_toggle']);
  }

  public function build(): array {
    $config = $this->getConfiguration();

    $attributes = [
      // Html::getUniqueId() rather than a bare literal: the id is no
      // longer safe to hardcode now that two placements are a supported
      // configuration. The FIRST instance on a page still gets the exact
      // original 'libcal-gantt-chart', so any existing site CSS or
      // scripting keyed to that id is unaffected; a second instance gets
      // a suffixed id instead of an HTML-invalid duplicate. The
      // JavaScript never relies on the id - it binds by class - so this
      // matters only for external consumers.
      'id' => Html::getUniqueId('libcal-gantt-chart'),
      'class' => ['libcal-gantt-chart'],

      // Per-instance display settings travel as data-* attributes rather
      // than through drupalSettings, which is a single global bag keyed
      // by module name: two placements on one page would overwrite each
      // other's values there. The endpoint below stays in drupalSettings
      // precisely because it is genuinely global - same route, same
      // value, for every instance.
      //
      // Booleans are emitted as the strings '1'/'0' because a data-*
      // attribute has no boolean type; the JavaScript compares against
      // '0' so that a MISSING attribute reads as enabled-by-default.
      'data-render-mode' => $config['render_mode'] === 'homepage' ? 'homepage' : 'grid',
      'data-show-legend' => !empty($config['show_legend']) ? '1' : '0',
      'data-theme' => in_array($config['theme'], ['dark', 'light', 'auto'], TRUE) ? $config['theme'] : 'dark',
      'data-theme-toggle' => !empty($config['allow_theme_toggle']) ? '1' : '0',
    ];

    // Teaser-only settings are omitted entirely for the grid, so the
    // rendered markup carries no attributes that variant cannot act on.
    if ($attributes['data-render-mode'] === 'homepage') {
      $attributes['data-homepage-days'] = (string) max(1, (int) $config['homepage_days']);

      if ($config['chart_title'] !== '') {
        $attributes['data-chart-title'] = $config['chart_title'];
      }
      // Placement first, site setting second, no link third. Trimmed
      // because a placement holding only whitespace is an empty override,
      // not a destination.
      $fullCalendarUrl = trim((string) $config['full_calendar_url']) !== ''
        ? trim((string) $config['full_calendar_url'])
        : $this->siteFullCalendarUrl();
      if ($fullCalendarUrl !== '') {
        // Keep the canonical URL attribute and emit the historical alias
        // too, so markup cached from the earlier build and any external
        // inspection tooling resolve the same configured destination.
        $attributes['data-full-calendar-url'] = $fullCalendarUrl;
        $attributes['data-full-calendar'] = $fullCalendarUrl;
      }
    }

    return [
      '#type' => 'container',
      '#attributes' => $attributes,
      'loading' => [
        '#markup' => '<p class="libcal-gantt-chart__loading">' . $this->t('Loading upcoming events…') . '</p>',
      ],
      '#attached' => [
        'library' => ['libcal_gantt/gantt-timeline'],
        'drupalSettings' => [
          'libcalGantt' => [
            'endpoint' => Url::fromRoute('libcal_gantt.events')->toString(),
          ],
        ],
      ],
      '#cache' => [
        'max-age' => 300,
        // The markup now embeds a value from module settings, so it has to
        // be invalidated when that config is saved rather than only when
        // the max-age lapses.
        'tags' => $this->configFactory->get('libcal_gantt.settings')->getCacheTags(),
      ],
    ];
  }

  public function getCacheTags(): array {
    // Same reason as the #cache tags in build(): the "Full calendar" URL
    // travels in the block markup, so saving the setting must rebuild it.
    return Cache::mergeTags(
      parent::getCacheTags(),
      $this->configFactory->get('libcal_gantt.settings')->getCacheTags()
    );
  }

  public function getCacheMaxAge(): int {
    // The block markup itself is just a container; the real data is
    // fetched client-side on every page view, so a short server cache is
    // fine even though events change throughout the day.
    return 300;
  }

}
