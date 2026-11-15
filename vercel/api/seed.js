// Demo seed: one restaurant, 8 tables, a starter menu.
// Run on every boot when the store is empty (memory adapter) or when
// SEED=true (postgres adapter). Safe to re-run: it only fills gaps.
//
// Table QR tokens are DETERMINISTIC (a hash of the table number), not
// random. On free serverless hosting every function instance holds its
// own memory store and re-seeds on cold start; random tokens meant one
// instance's printed QR 410'd on every other instance. Deterministic
// tokens make every instance agree, so a scanned QR resolves anywhere.
// (The token is printed on the table, so it was never a secret — the
// real protections are waiter approval + the per-session code. With a
// shared Postgres store, tokens could be random again; the seed keeps
// them deterministic so both adapters behave identically.)
const crypto = require("crypto");
const tableToken = (n) =>
  crypto.createHash("sha256").update(`tableorder-table-${n}`).digest("hex").slice(0, 32);

// Prices are in paise (priceCents = paise here, so 24900 = ₹249).
const MENU = [
  { name: "Tomato Bruschetta", description: "Grilled sourdough, vine tomatoes, basil, garlic oil", priceCents: 24900, category: "Starters", imageUrl: "https://images.unsplash.com/photo-1572695157366-5e585ab2b69f?w=800&q=80" },
  { name: "Garlic Butter Prawns", description: "Pan-seared prawns, garlic butter, lemon, parsley", priceCents: 34900, category: "Starters", imageUrl: "https://images.unsplash.com/photo-1559742811-822873691df8?w=800&q=80" },
  { name: "Margherita Pizza", description: "San Marzano tomato, fior di latte, basil, wood-fired", priceCents: 29900, category: "Mains", imageUrl: "https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=800&q=80" },
  { name: "Truffle Tagliatelle", description: "Fresh pasta, black truffle cream, parmesan", priceCents: 39900, category: "Mains", imageUrl: "https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=800&q=80" },
  { name: "Grilled Salmon", description: "Char-grilled fillet, herb oil, seasonal vegetables", priceCents: 49900, category: "Mains", imageUrl: "https://images.unsplash.com/photo-1467003909585-2f8a72700288?w=800&q=80" },
  { name: "Smash Burger", description: "Double smashed patty, cheddar, house pickles, fries", priceCents: 29900, category: "Mains", imageUrl: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=800&q=80" },
  { name: "Caesar Salad", description: "Romaine, anchovy dressing, croutons, aged parmesan", priceCents: 24900, category: "Starters", imageUrl: "https://images.unsplash.com/photo-1550304943-4f24a54dd1c4?w=800&q=80" },
  { name: "Tiramisu", description: "Espresso-soaked sponge, mascarpone, cocoa", priceCents: 19900, category: "Desserts", imageUrl: "https://images.unsplash.com/photo-1571877227200-a0d98ea607e9?w=800&q=80" },
  { name: "Chocolate Fondant", description: "Warm dark chocolate cake, vanilla ice cream", priceCents: 22900, category: "Desserts", imageUrl: "https://images.unsplash.com/photo-1606313564200-e75d5e30476c?w=800&q=80" },
  { name: "Fresh Lemonade", description: "Hand-pressed lemons, mint, sparkling water", priceCents: 12900, category: "Drinks", imageUrl: "https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=800&q=80" },
  { name: "Cold Brew Coffee", description: "18-hour steeped single origin, served over ice", priceCents: 14900, category: "Drinks", imageUrl: "https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=800&q=80" },
  { name: "Sparkling Water", description: "750ml bottle, chilled", priceCents: 9900, category: "Drinks", imageUrl: "https://images.unsplash.com/photo-1523362628745-0c100150b504?w=800&q=80" },
  // --- Indian kitchen ---
  { name: "Vegetable Samosa (2 pc)", description: "Crisp pastry, spiced potato-pea filling, mint chutney", priceCents: 9900, category: "Starters", imageUrl: "https://images.unsplash.com/photo-1601050690597-df0568f70950?w=800&q=80" },
  { name: "Paneer Tikka", description: "Char-grilled cottage cheese, peppers, smoky yoghurt marinade", priceCents: 24900, category: "Starters", imageUrl: "https://images.unsplash.com/photo-1567188040759-fb8a883dc6d6?w=800&q=80" },
  { name: "Chicken 65", description: "Fiery South Indian fried chicken, curry leaves, lemon", priceCents: 26900, category: "Starters", imageUrl: "https://images.unsplash.com/photo-1569058242253-92a9c755a0ec?w=800&q=80" },
  { name: "Butter Chicken", description: "Tandoori chicken folded into tomato-butter gravy, cream", priceCents: 34900, category: "Mains", imageUrl: "https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=800&q=80" },
  { name: "Chicken Biryani", description: "Fragrant basmati, saffron, fried onions, raita", priceCents: 29900, category: "Mains", imageUrl: "https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&q=80" },
  { name: "Paneer Butter Masala", description: "Cottage cheese in a rich tomato-cashew gravy", priceCents: 26900, category: "Mains", imageUrl: "https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=800&q=80" },
  { name: "Masala Dosa", description: "Crisp rice crêpe, spiced potato, coconut chutney, sambar", priceCents: 17900, category: "Mains", imageUrl: "https://images.unsplash.com/photo-1630383249896-424e482df921?w=800&q=80" },
  { name: "Veg Biryani", description: "Seasonal vegetables, saffron rice, mint raita", priceCents: 22900, category: "Mains", imageUrl: "https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=800&q=80" },
  { name: "Butter Naan", description: "Tandoor-baked leavened bread, brushed with butter", priceCents: 4900, category: "Breads", imageUrl: "https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=800&q=80" },
  { name: "Garlic Naan", description: "Tandoor-baked bread, garlic, coriander, butter", priceCents: 5900, category: "Breads", imageUrl: "https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800&q=80" },
  { name: "Gulab Jamun (2 pc)", description: "Warm syrup-soaked dumplings, cardamom", priceCents: 9900, category: "Desserts", imageUrl: "https://images.unsplash.com/photo-1666190092159-3171cf0fbb12?w=800&q=80" },
  { name: "Mango Kulfi", description: "Dense slow-reduced milk ice cream, Alphonso mango", priceCents: 12900, category: "Desserts", imageUrl: "https://images.unsplash.com/photo-1563805042-7684c019e1cb?w=800&q=80" },
  { name: "Mango Lassi", description: "Thick yoghurt blended with Alphonso mango", priceCents: 12900, category: "Drinks", imageUrl: "https://images.unsplash.com/photo-1626200419199-391ae4be7a41?w=800&q=80" },
  { name: "Masala Chai", description: "Assam tea simmered with ginger, cardamom and milk", priceCents: 7900, category: "Drinks", imageUrl: "https://images.unsplash.com/photo-1571934811356-5cc061b6821f?w=800&q=80" },
  { name: "Filter Coffee", description: "Strong South Indian filter coffee, hot frothed milk", priceCents: 6900, category: "Drinks", imageUrl: "https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=800&q=80" },
];

async function seed(store) {
  if ((await store.listTables()).length === 0) {
    for (let n = 1; n <= 8; n++) {
      await store.upsertTable({
        id: n,
        number: n,
        label: `Table ${n}`,
        qrToken: tableToken(n),
        status: "free",
        codeAttempts: 0,
        lockedUntil: null,
      });
    }
  }
  if ((await store.listMenu()).length === 0) {
    for (const item of MENU) await store.createMenuItem(item);
  }
}

module.exports = { seed, MENU };
