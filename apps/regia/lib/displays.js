'use strict';

/**
 * Which screen gets the clean feed. The mixer is plugged into the control
 * room PC's second output, so "automatic" means the first screen that is not
 * the primary one. A screen chosen from the menu wins while it is connected.
 */

function describe(display, index, primaryId) {
  const { width, height } = display.size || display.bounds;
  const name = display.label || `Schermo ${index + 1}`;
  return `${name} — ${width}×${height}${display.id === primaryId ? ' (principale)' : ''}`;
}

/**
 * @param displays  screen.getAllDisplays()
 * @param primaryId screen.getPrimaryDisplay().id
 * @param preferred { id, label } saved choice, or null for automatic
 * @returns the display, or null when there is nowhere to put the feed
 */
function pickFeedDisplay(displays, primaryId, preferred) {
  if (preferred) {
    const byId = displays.find((d) => d.id === preferred.id);
    if (byId) return byId;
    // Ids can change when a screen is unplugged and plugged back in.
    const byLabel = preferred.label && displays.find((d) => d.label === preferred.label);
    if (byLabel) return byLabel;
  }
  return displays.find((d) => d.id !== primaryId) || null;
}

module.exports = { pickFeedDisplay, describe };
