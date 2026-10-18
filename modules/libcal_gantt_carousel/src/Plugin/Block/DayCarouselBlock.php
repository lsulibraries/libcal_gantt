<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt_carousel\Plugin\Block;

use Drupal\Component\Utility\Html;
use Drupal\Core\Block\Attribute\Block;
use Drupal\Core\Block\BlockBase;
use Drupal\Core\Cache\Cache;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\Plugin\ContainerFactoryPluginInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Url;
use Drupal\libcal_gantt\Form\SettingsForm;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Full-height carousel with one slide per library day.
 *
 * Uses the parent module's settings (credentials, calendars, rows, hours
 * feeds, weather coordinates). Nothing here is configured twice.
 */
#[Block(
  id: 'libcal_gantt_day_carousel',
  admin_label: new TranslatableMarkup('LibCal Day Carousel (Bootstrap)'),
)]
class DayCarouselBlock extends BlockBase implements ContainerFactoryPluginInterface {

  public function __construct(array $configuration, $plugin_id, $plugin_definition, protected ConfigFactoryInterface $configFactory) {
    parent::__construct($configuration, $plugin_id, $plugin_definition);
  }

  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
    return new static($configuration, $plugin_id, $plugin_definition, $container->get('config.factory'));
  }

  public function defaultConfiguration(): array {
    return [
      'max_days' => 7,
      'include_weekends' => TRUE,
      'only_event_days' => FALSE,
      'events_per_slide' => 6,
      'show_hours' => TRUE,
      'show_images' => TRUE,
      'interval' => 0,
      'calendar' => '',
      'full_calendar_url' => '',
      'aria_label' => '',
    ] + parent::defaultConfiguration();
  }

  public function blockForm($form, FormStateInterface $form_state): array {
    $c = $this->getConfiguration();
    $form['max_days'] = [
      '#type' => 'number', '#title' => $this->t('Slides (days)'), '#min' => 1, '#max' => 14,
      '#default_value' => $c['max_days'],
      '#description' => $this->t('Weather is available for about 7 days. Later slides show events and hours only.'),
    ];
    $form['include_weekends'] = [
      '#type' => 'checkbox', '#title' => $this->t('Include Saturday and Sunday slides'),
      '#default_value' => $c['include_weekends'],
    ];
    $form['only_event_days'] = [
      '#type' => 'checkbox', '#title' => $this->t('Show only event days'),
      '#default_value' => $c['only_event_days'],
      '#description' => $this->t('Hide all-day events and skip days with no other events. "Slides (days)" then counts event days, taken from the next two weeks or so.'),
    ];
    $form['events_per_slide'] = [
      '#type' => 'number', '#title' => $this->t('Events listed per slide'), '#min' => 1, '#max' => 20,
      '#default_value' => $c['events_per_slide'],
      '#description' => $this->t('Additional events are summarized with a link to the full calendar.'),
    ];
    $form['show_hours'] = [
      '#type' => 'checkbox', '#title' => $this->t('Show building hours'), '#default_value' => $c['show_hours'],
    ];
    $form['show_images'] = [
      '#type' => 'checkbox', '#title' => $this->t("Show the first event's featured image"), '#default_value' => $c['show_images'],
    ];
    $form['interval'] = [
      '#type' => 'number', '#title' => $this->t('Autoplay interval (ms)'), '#min' => 0, '#step' => 500,
      '#default_value' => $c['interval'],
      '#description' => $this->t('0 turns autoplay off (recommended). Autoplay is always off for visitors who prefer reduced motion.'),
    ];
    $form['calendar'] = [
      '#type' => 'textfield', '#title' => $this->t('Calendar key'), '#default_value' => $c['calendar'],
      '#description' => $this->t('Optional. A key from the "Calendars" setting of LibCal Gantt Timeline. Leave empty to use the first calendar.'),
    ];
    $form['full_calendar_url'] = [
      '#type' => 'textfield', '#title' => $this->t('Full calendar URL'), '#maxlength' => 255,
      '#default_value' => $c['full_calendar_url'],
      '#description' => $this->t('Leave empty to use the site-wide URL from the LibCal Gantt settings.'),
    ];
    $form['aria_label'] = [
      '#type' => 'textfield', '#title' => $this->t('Accessible name'), '#default_value' => $c['aria_label'],
      '#description' => $this->t('Defaults to "Upcoming library days".'),
    ];
    return $form;
  }

  public function blockSubmit($form, FormStateInterface $form_state): void {
    foreach (['max_days', 'events_per_slide', 'interval'] as $key) {
      $this->configuration[$key] = max(0, (int) $form_state->getValue($key));
    }
    foreach (['include_weekends', 'only_event_days', 'show_hours', 'show_images'] as $key) {
      $this->configuration[$key] = (bool) $form_state->getValue($key);
    }
    foreach (['calendar', 'full_calendar_url', 'aria_label'] as $key) {
      $this->configuration[$key] = trim((string) $form_state->getValue($key));
    }
  }

  public function build(): array {
    $c = $this->getConfiguration();
    $settings = $this->configFactory->get('libcal_gantt.settings');

    $fullCalendarUrl = $c['full_calendar_url'] !== ''
      ? $c['full_calendar_url']
      : trim((string) ($settings->get('full_calendar_url') ?? SettingsForm::DEFAULT_FULL_CALENDAR_URL));

    return [
      '#type' => 'container',
      '#attributes' => [
        'id' => Html::getUniqueId('libcal-day-carousel'),
        'class' => ['libcal-day-carousel'],
        // Keeps the Palefire TOC from listing the slide headings.
        'data-toc-skip' => '',
        'data-max-days' => (string) max(1, (int) $c['max_days']),
        'data-include-weekends' => $c['include_weekends'] ? '1' : '0',
        'data-only-event-days' => !empty($c['only_event_days']) ? '1' : '0',
        'data-events-per-slide' => (string) max(1, (int) $c['events_per_slide']),
        'data-show-hours' => $c['show_hours'] ? '1' : '0',
        'data-show-images' => $c['show_images'] ? '1' : '0',
        'data-interval' => (string) (int) $c['interval'],
        'data-calendar' => $c['calendar'],
        'data-full-calendar-url' => $fullCalendarUrl,
        'data-label' => $c['aria_label'] !== '' ? $c['aria_label'] : (string) $this->t('Upcoming library days'),
      ],
      'loading' => [
        '#markup' => '<p class="libcal-day-carousel__status">' . $this->t('Loading upcoming days…') . '</p>',
      ],
      '#attached' => [
        'library' => ['libcal_gantt_carousel/day-carousel'],
        'drupalSettings' => [
          'libcalGanttCarousel' => [
            'endpoint' => Url::fromRoute('libcal_gantt_carousel.events')->toString(),
          ],
        ],
      ],
      '#cache' => [
        'max-age' => 300,
        'tags' => $settings->getCacheTags(),
      ],
    ];
  }

  public function getCacheTags(): array {
    return Cache::mergeTags(parent::getCacheTags(), $this->configFactory->get('libcal_gantt.settings')->getCacheTags());
  }

  public function getCacheMaxAge(): int {
    return 300;
  }

}
