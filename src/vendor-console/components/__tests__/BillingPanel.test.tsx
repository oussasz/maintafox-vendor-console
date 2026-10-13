import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/services/license-control-service", () => ({
  PRIVILEGED_REASON_MIN_LENGTH: 4,
  listTenants: vi.fn(async () => [{ id: "tenant_1", slug: "acme", display_name: "Acme" }]),
}));

vi.mock("@/services/billing-service", () => ({
  getSubscription: vi.fn(),
  reconcilePayment: vi.fn(),
  createPaymentLink: vi.fn(),
}));

import { createPaymentLink, getSubscription, reconcilePayment, type Subscription } from "@/services/billing-service";
import { BillingPanel } from "../BillingPanel";

const awaiting = {
  id: "order_1",
  tenant_id: "tenant_1",
  license_id: "lic_1",
  plan: "standard",
  amount: 50000,
  extra_slots: 2,
  total_amount: 52000,
  currency: "DZD",
  status: "awaiting_payment" as const,
  slickpay_invoice_id: "1001",
  paid_at: null,
  error_message: null,
  created_at: "2026-10-12T10:00:00Z",
  updated_at: "2026-10-12T10:00:00Z",
  last_reconciled_at: null,
  last_reconciled_status: null,
};

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    tenant_id: "tenant_1",
    licences: [
      {
        id: "lic_1",
        max_machines: 1,
        active_machines: 1,
        expires_at: "2026-10-30T00:00:00Z",
        days_left: 17,
        revoked_at: null,
        update_channel: "stable",
      },
    ],
    payments: [awaiting],
    slickpay_configured: true,
    extra_slot_price: 1000,
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <BillingPanel />
    </MemoryRouter>,
  );
}

describe("BillingPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the licence term, slots and the payment status exactly as recorded", async () => {
    vi.mocked(getSubscription).mockResolvedValue(subscription());
    renderPanel();
    expect(await screen.findByText("billing.licence.daysLeft")).toHaveClass("text-attention-text");
    expect(screen.getByText("billing.licence.slots")).toBeInTheDocument();
    const row = screen.getByTestId("payment-order_1");
    expect(within(row).getByText("billing.status.awaiting_payment")).toBeInTheDocument();
    expect(within(row).getByText("52000 DZD")).toBeInTheDocument();
    expect(screen.getByText("billing.openOrders")).toBeInTheDocument();
  });

  it("checks with SlickPay (reason required) and reloads the server's answer", async () => {
    vi.mocked(getSubscription)
      .mockResolvedValueOnce(subscription())
      .mockResolvedValueOnce(subscription({ payments: [{ ...awaiting, status: "paid", paid_at: "2026-10-12T11:00:00Z" }] }));
    vi.mocked(reconcilePayment).mockResolvedValue({
      payment_order_id: "order_1",
      stored_status: "awaiting_payment",
      slickpay_status: "paid",
      applied: true,
      outcome: "applied",
      order: { ...awaiting, status: "paid" },
    });
    renderPanel();
    const row = await screen.findByTestId("payment-order_1");
    await userEvent.click(within(row).getByRole("button", { name: "billing.reconcile.button" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("operatorAction.reasonLabel"), "customer called");
    await userEvent.click(within(dialog).getByRole("button", { name: "billing.reconcile.confirm" }));
    await waitFor(() => expect(reconcilePayment).toHaveBeenCalledWith("order_1", "customer called"));
    expect(await screen.findByText("billing.reconcile.outcome.applied")).toBeInTheDocument();
    expect(await screen.findByText("billing.status.paid")).toBeInTheDocument();
  });

  it("without SlickPay configured, says so and offers no SlickPay action", async () => {
    vi.mocked(getSubscription).mockResolvedValue(subscription({ slickpay_configured: false }));
    renderPanel();
    expect(await screen.findByText("billing.slickpayOff")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "billing.link.button" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "billing.reconcile.button" })).not.toBeInTheDocument();
  });

  it("creates a payment link and shows it to send to the customer", async () => {
    vi.mocked(getSubscription).mockResolvedValue(subscription());
    vi.mocked(createPaymentLink).mockResolvedValue({
      checkout_url: "https://pay.example.test/invoice/1002",
      payment_order_id: "order_2",
      total_amount: 51000,
      currency: "DZD",
    });
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "billing.link.button" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("operatorAction.reasonLabel")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("billing.link.plan"), "standard");
    await userEvent.type(within(dialog).getByLabelText("billing.link.amount"), "50000");
    await userEvent.clear(within(dialog).getByLabelText("billing.link.extraSlots"));
    await userEvent.type(within(dialog).getByLabelText("billing.link.extraSlots"), "1");
    await userEvent.click(within(dialog).getByRole("button", { name: "billing.link.confirm" }));
    await waitFor(() =>
      expect(createPaymentLink).toHaveBeenCalledWith({ tenant_id: "tenant_1", plan: "standard", amount: 50000, extra_slots: 1 }),
    );
    expect(await screen.findByTestId("checkout-url")).toHaveTextContent("https://pay.example.test/invoice/1002");
  });
});
