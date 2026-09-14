<?php

declare(strict_types=1);

namespace Drupal\libcal_gantt\Plugin\Block;

use Drupal\Core\Block\Attribute\Block;
use Drupal\Core\Block\BlockBase;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Url;

/**
 * Provides the "LibCal Events Gantt Chart" block.
 *
 * Place this block in any region of your custom theme. It renders an
 * empty container plus the gantt-timeline library; the JavaScript fetches
 * /libcal-gantt/events and builds the chart client-side, so the block
 * itself stays cheap to render and cacheable.
 */
#[Block(
  id: 'libcal_gantt_chart',
  admin_label: new TranslatableMarkup('LibCal Events Gantt Chart'),
)]
class GanttChartBlock extends BlockBase {

  public function build(): array {
    return [
      '#type' => 'container',
      '#attributes' => [
        'id' => 'libcal-gantt-chart',
        'class' => ['libcal-gantt-chart'],
      ],
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
