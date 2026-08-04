// Traveling-Salesperson-style stop ordering for Smart Routing. Deliberately
// hand-rolled rather than a library — nearest-neighbour + 2-opt is a well
// known combination that gets within a few percent of optimal for the
// small stop counts this feature deals with (spec caps selection at 8-10
// centres), so a real solver would be overkill.

// Greedy pass: from the start, repeatedly jump to whichever unvisited stop
// is closest. Fast, and a good enough starting tour for 2-opt to refine.
function nearestNeighborOrder(durationsMinutes, startIndex, stopIndices) {
  const remaining = new Set(stopIndices);
  const order = [];
  let current = startIndex;
  while (remaining.size) {
    let best = null;
    let bestCost = Infinity;
    for (const idx of remaining) {
      const cost = durationsMinutes[current][idx];
      if (cost < bestCost) { bestCost = cost; best = idx; }
    }
    order.push(best);
    remaining.delete(best);
    current = best;
  }
  return order;
}

function pathCost(durationsMinutes, startIndex, order) {
  let total = 0;
  let prev = startIndex;
  for (const idx of order) {
    total += durationsMinutes[prev][idx];
    prev = idx;
  }
  return total;
}

// Standard 2-opt local search for an OPEN path (starts fixed at
// startIndex, no forced return leg) — repeatedly reverses a segment of the
// tour whenever doing so shortens total travel time, until no single swap
// helps anymore.
function twoOptImprove(durationsMinutes, startIndex, initialOrder) {
  let order = initialOrder.slice();
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const candidate = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        if (pathCost(durationsMinutes, startIndex, candidate) < pathCost(durationsMinutes, startIndex, order) - 1e-9) {
          order = candidate;
          improved = true;
        }
      }
    }
  }
  return order;
}

// stopIndices are indices into the same coordinate list as durationsMinutes
// (startIndex is index 0 by convention, stops are indices 1..N — see
// routes/routePlanner.js). Returns the optimized visiting order.
function optimizeRoute(durationsMinutes, startIndex, stopIndices) {
  if (stopIndices.length <= 1) return stopIndices.slice();
  const greedy = nearestNeighborOrder(durationsMinutes, startIndex, stopIndices);
  return twoOptImprove(durationsMinutes, startIndex, greedy);
}

const VISIT_DURATION_MINUTES = 45;
const LUNCH_DURATION_MINUTES = 45;
const LUNCH_WINDOW = { startMinutes: 12 * 60, endMinutes: 13 * 60 + 30 };

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Pure schedule builder — takes an already-ordered stop list plus the
// per-leg drive times between them (legMinutes[i] = drive time from the
// previous location to stops[i]; legMinutes[0] is start → first stop) and
// lays out a chronological timeline, inserting the mandatory lunch break
// the first time the clock enters the 12:00-13:30 window. legMinutes
// entries may be null (Mapbox not configured yet) — those render as an
// "unavailable" drive block instead of a fabricated duration.
function buildItinerary({ stops, legMinutes, legDistancesKm, departureTime, startLabel }) {
  const blocks = [];
  let clock = new Date(departureTime);
  let lunchInserted = false;
  let totalDriveMinutes = 0;
  let totalDriveKm = 0;
  let driveDataComplete = true;

  stops.forEach((stop, i) => {
    const minutes = legMinutes[i];
    const km = legDistancesKm ? legDistancesKm[i] : null;
    if (minutes == null) driveDataComplete = false;
    else { totalDriveMinutes += minutes; if (km != null) totalDriveKm += km; }

    const driveStart = clock;
    const driveEnd = minutes != null ? addMinutes(clock, minutes) : clock;
    blocks.push({
      type: 'drive',
      from: i === 0 ? startLabel : stops[i - 1].centre_name,
      to: stop.centre_name,
      minutes, km,
      start: driveStart, end: driveEnd
    });
    clock = driveEnd;

    if (!lunchInserted && minutesOfDay(clock) >= LUNCH_WINDOW.startMinutes && minutesOfDay(clock) <= LUNCH_WINDOW.endMinutes) {
      const lunchStart = clock;
      const lunchEnd = addMinutes(clock, LUNCH_DURATION_MINUTES);
      blocks.push({ type: 'lunch', label: 'Lunch & Admin Break', start: lunchStart, end: lunchEnd });
      clock = lunchEnd;
      lunchInserted = true;
    }

    const visitStart = clock;
    const visitEnd = addMinutes(clock, VISIT_DURATION_MINUTES);
    blocks.push({ type: 'visit', stop, start: visitStart, end: visitEnd });
    clock = visitEnd;
  });

  return {
    blocks,
    totalDriveMinutes: driveDataComplete ? totalDriveMinutes : null,
    totalDriveKm: driveDataComplete ? totalDriveKm : null,
    totalVisitMinutes: stops.length * VISIT_DURATION_MINUTES + (lunchInserted ? LUNCH_DURATION_MINUTES : 0),
    driveDataComplete,
    lunchInserted
  };
}

module.exports = { optimizeRoute, nearestNeighborOrder, twoOptImprove, buildItinerary, VISIT_DURATION_MINUTES, LUNCH_DURATION_MINUTES };
