function moneyToCents(value) {
  return Math.round(Number(value) * 100);
}

function centsToMoney(cents) {
  return Number((cents / 100).toFixed(2));
}

function calculateBill(order) {
  let subtotalCents = 0;
  let taxCents = 0;
  for (const item of order.items) {
    const itemCents = moneyToCents(item.price);
    subtotalCents += itemCents;
    taxCents += Math.round(itemCents * (item.category === "food" ? 0.05 : 0.18));
  }
  const serviceChargeCents = Math.round(subtotalCents * 0.1);
  return {
    subtotal: centsToMoney(subtotalCents),
    gst: centsToMoney(taxCents),
    serviceCharge: centsToMoney(serviceChargeCents),
    total: centsToMoney(subtotalCents + taxCents + serviceChargeCents)
  };
}

module.exports = { calculateBill, centsToMoney, moneyToCents };
