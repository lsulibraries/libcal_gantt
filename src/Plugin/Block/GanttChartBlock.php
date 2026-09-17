<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt\Plugin\Block;

use Drupal\Core\Block\Attribute\Block;
use Drupal\Core\Block\BlockBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Component\Utility\Html;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Url;

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
class GanttChartBlock extends BlockBase {

  /**
   * TEMPORARY stand-in target for the "Full calendar" link.
   *
   * Used only when a placement's own "Full calendar URL" is blank, so
   * anything configured in the block form still wins. Applied at build
   * time rather than in defaultConfiguration(), because defaults are read
   * only when a block is FIRST placed: an existing placement already has
   * an empty string saved against this key, and a new default would never
   * be consulted for it.
   *
   * To retire this, delete the constant and restore the plain
   * `$config['full_calendar_url'] !== ''` test in build(). Two lines, one
   * place.
   */
  const TEMPORARY_FULL_CALENDAR_URL = 'https://lsu.libcal.com/calendar/eventsandprogramming?cid=-1&t=m&d=0000-00-00&cal=-1&inc=0';

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

    $form['homepage']['full_calendar_url'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Full calendar URL'),
      '#default_value' => $config['full_calendar_url'],
      '#maxlength' => 255,
      '#description' => $this->t('Target of the "Full calendar" link, e.g. /events or https://lib.lsu.edu/events. Temporarily, leaving this empty falls back to the LibCal events and programming calendar rather than omitting the link.'),
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
      // TEMPORARY: falls back to TEMPORARY_FULL_CALENDAR_URL while the
      // real destination is being decided. A URL entered in the block form
      // still takes precedence; only a blank one picks up the stand-in.
      $fullCalendarUrl = $config['full_calendar_url'] !== ''
        ? $config['full_calendar_url']
        : self::TEMPORARY_FULL_CALENDAR_URL;
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
      ],
    ];
  }

  public function getCacheMaxAge(): int {
    // The block markup itself is just a container; the real data is
    // fetched client-side on every page view, so a short server cache is
    // fine even though events change throughout the day.
    return 300;
  }

}
