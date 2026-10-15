/**
 * @file
 * Initializes LibCal "today's hours" widgets from s_lc_tdh_<iid>_<lid>
 * placeholders, replacing the inline <script> LibCal's embed code uses.
 */
(function (Drupal, once, $) {
  'use strict';

  Drupal.behaviors.libcalGanttTodayHours = {
    attach(context) {
      once('libcal-today-hours', '[id^="s_lc_tdh_"]', context).forEach((el) => {
        const m = el.id.match(/^s_lc_tdh_(\d+)_(\d+)$/);
        if (!m || typeof $.LibCalTodayHours !== 'function') {
          return;
        }
        new $.LibCalTodayHours($(el), { iid: Number(m[1]), lid: Number(m[2]) });
      });
    },
  };
})(Drupal, once, jQuery);
