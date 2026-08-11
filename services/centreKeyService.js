// A "centre" in My Centres/Centre 360 is RT's real client/location data,
// not a row in our own `leads` table — RT's live client list is
// RawTalent's actual ~1,100-centre book of business (most predating this
// app), while 0 leads have ever reached signed_status='signed' in
// production. So every centre needs one stable identity derived straight
// from RT, usable as a URL param and as centre_visits.centre_key, without
// requiring a local leads row to exist at all.
//
// One RT Client can have multiple locations[] (each its own physical
// centre, with its own clientsLocationId — the real join key for booking
// data, since Booking.locationId matches clientsLocationId, not the
// parent Client.clientId). A location-level key is used whenever a
// location exists; the rarer client with no locations[] on file falls
// back to a client-level key so it can still appear in the list.

function keyForLocation(locationId) {
  return `loc:${locationId}`;
}

function keyForClient(clientId) {
  return `client:${clientId}`;
}

function parseCentreKey(centreKey) {
  const [type, idStr] = (centreKey || '').split(':');
  const id = Number(idStr);
  if ((type !== 'loc' && type !== 'client') || !Number.isFinite(id)) return null;
  return { type, id };
}

// Flattens RT's clients[] (each with a locations[] array) into one row per
// physical centre — the shape every route in routes/centres.js works
// with. `client.locations` comes straight from rtApiReportService's live
// `clients` fetch.
function flattenCentres(clients) {
  const centres = [];
  for (const client of clients || []) {
    const locations = client.locations || [];
    if (!locations.length) {
      centres.push({
        centreKey: keyForClient(client.clientId),
        rtClientId: client.clientId,
        rtLocationId: null,
        name: client.name || client.nickName || 'Unnamed client',
        streetAddress: null,
        suburb: null,
        state: null,
        contactName: null,
        contactNo: client.contactNo || null,
        email: client.email || client.emailAddress || null,
        createdDate: client.createdDate || null,
        isActive: client.isActive !== false
      });
      continue;
    }
    for (const loc of locations) {
      // RT's location address is two free-text lines (addressLine1/2), not
      // a single street-address field — verified against a real client
      // record (e.g. "72" / "Grey Street"). state is a full name
      // ("Victoria"), not the "VIC"/"SA" abbreviations leads.state uses —
      // callers matching against leads rows need to normalise this.
      centres.push({
        centreKey: keyForLocation(loc.clientsLocationId),
        rtClientId: client.clientId,
        rtLocationId: loc.clientsLocationId,
        name: loc.locationName || client.name || client.nickName || 'Unnamed client',
        streetAddress: [loc.addressLine1, loc.addressLine2].filter(Boolean).join(' '),
        suburb: loc.suburb || null,
        state: loc.state || null,
        contactName: loc.contactName || null,
        contactNo: loc.contactNo || client.landLineNo || client.contactNo || null,
        email: client.email || client.emailAddress || null,
        createdDate: client.createdDate || null,
        isActive: client.isActive !== false && loc.isActive !== false
      });
    }
  }
  return centres;
}

module.exports = { keyForLocation, keyForClient, parseCentreKey, flattenCentres };
