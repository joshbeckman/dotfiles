# Event API context

Event IDs are unique and increase monotonically within the stream. The service retains events for seven days. Existing clients call `GET /events?after_id=evt_123` and expect a JSON object with an `events` array.
