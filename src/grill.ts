// A small client for The Copper Grill's assistant API (/api/assistant on the
// restaurant's site). Every call sends the shared key as a Bearer token.
// See docs/assistant-api.md in the copper-grill repository.

export type Booking = {
  token: string;
  date: string;
  time: string;
  until: string;
  partySize: number;
  table: string;
  area: string;
  status: string;
  guestName: string;
  manageUrl: string;
};

export type Reminder = {
  token: string;
  guestName: string;
  guestPhone: string;
  time: string;
  partySize: number;
  table: string;
  manageUrl: string;
};

/** What the site answered: its JSON body plus whether it was a success. */
export type GrillReply<T = Record<string, unknown>> = { ok: boolean; status: number; body: T };

export type Grill = {
  info(): Promise<GrillReply>;
  availability(date: string, party: number): Promise<GrillReply>;
  book(booking: Record<string, unknown>): Promise<GrillReply>;
  bookingsFor(phone: string): Promise<GrillReply<{ bookings?: Booking[] }>>;
  /** `phone` is the sender's number: the site cancels a booking only for the number it was made with. */
  cancel(token: string, phone: string): Promise<GrillReply>;
  enquiry(enquiry: Record<string, unknown>): Promise<GrillReply>;
  reminders(date: string): Promise<GrillReply<{ reminders?: Reminder[] }>>;
};

export function grillClient(baseUrl: string, apiKey: string): Grill {
  const base = baseUrl.replace(/\/$/, "") + "/api/assistant";

  async function call<T>(path: string, init: RequestInit = {}): Promise<GrillReply<T>> {
    const response = await fetch(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as T;
    return { ok: response.ok, status: response.status, body };
  }

  const q = encodeURIComponent;
  return {
    info: () => call("/info"),
    availability: (date, party) => call(`/availability?date=${q(date)}&party=${q(String(party))}`),
    book: (booking) => call("/bookings", { method: "POST", body: JSON.stringify(booking) }),
    bookingsFor: (phone) => call(`/bookings?phone=${q(phone)}`),
    cancel: (token, phone) => call(`/bookings/${q(token)}?phone=${q(phone)}`, { method: "DELETE" }),
    enquiry: (enquiry) => call("/enquiries", { method: "POST", body: JSON.stringify(enquiry) }),
    reminders: (date) => call(`/reminders?date=${q(date)}`),
  };
}
