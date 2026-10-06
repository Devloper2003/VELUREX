/**
 * Velurex HMS — DEMO Seed script (local SQLite sandbox only)
 * Run: bun prisma/seed.ts
 * Seeds: 1 property, 4 staff (one per role), 4 room types, 20 rooms / 3 floors,
 * rate plans, 10 guests, reservations + folios + payments, restaurant menu,
 * housekeeping tasks, maintenance tickets, promo codes, night-audit history.
 *
 * ⚠️  HARD GUARD: this script plants DEMO data. It must NEVER run against the
 * live Neon PostgreSQL database — the live owner (Sujeet Sharma) works with
 * real data only. Use `bun prisma/seed-live.ts` for the live DB instead.
 */
import "./env-guard-demo";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";
import { encryptJSON } from "../src/lib/crypto";

const db = new PrismaClient();

function day(offset: number, hour = 12): Date {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function nights(a: Date, b: Date) {
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / 86400000));
}

async function main() {
  console.log("Clearing existing data…");
  // ── SaaS platform tables first (they FK-reference Property)
  await db.usageMetric.deleteMany();
  await db.announcementRead.deleteMany();
  await db.announcement.deleteMany();
  await db.onboardingChecklist.deleteMany();
  await db.ticketMessage.deleteMany();
  await db.supportTicket.deleteMany();
  await db.couponRedemption.deleteMany();
  await db.coupon.deleteMany();
  await db.platformPayment.deleteMany();
  await db.invoiceItem.deleteMany();
  await db.invoice.deleteMany();
  await db.featureOverride.deleteMany();
  await db.subscriptionAddon.deleteMany();
  await db.subscription.deleteMany();
  await db.lead.deleteMany();
  await db.platformAuditLog.deleteMany();
  await db.platformUser.deleteMany();
  await db.plan.deleteMany();
  await db.platformSetting.deleteMany();

  await db.whatsAppMessage.deleteMany();
  await db.activityLog.deleteMany();
  await db.nightAuditLog.deleteMany();
  await db.posOrderItem.deleteMany();
  await db.posOrder.deleteMany();
  await db.menuItem.deleteMany();
  await db.folioItem.deleteMany();
  await db.payment.deleteMany();
  await db.maintenanceTicket.deleteMany();
  await db.housekeepingTask.deleteMany();
  await db.reservation.deleteMany();
  await db.promoCode.deleteMany();
  await db.bookingHold.deleteMany();
  await db.channelSyncLog.deleteMany();
  await db.channelSyncJob.deleteMany();
  await db.roomInventory.deleteMany();
  await db.channelRoomMapping.deleteMany();
  await db.channelConnection.deleteMany();
  await db.ratePlan.deleteMany();
  await db.guest.deleteMany();
  await db.room.deleteMany();
  await db.roomType.deleteMany();
  await db.staff.deleteMany();
  await db.property.deleteMany();

  console.log("Creating property…");
  const property = await db.property.create({
    data: {
      name: "The Royal Grand Hotel",
      address: "12 Marine Drive, Nariman Point",
      city: "Mumbai",
      gstin: "27AABCU9603R1ZM",
      phone: "+91 22 4455 6677",
      email: "reservations@royalgrand.in",
      businessDate: day(0),
      noShowPercent: 100,
      auditCutoffHour: 14,
      isDemo: true, // seed demo tenant — hidden from the real owner's console
    },
  });

  console.log("Creating staff…");
  const staff = await Promise.all(
    [
      { name: "Rohan Mehta", email: "admin@velurex.in", role: "hotel_admin", pass: "admin123", phone: "+91 98200 11223" },
      { name: "Anjali Verma", email: "frontdesk@velurex.in", role: "front_desk", pass: "front123", phone: "+91 98200 44556" },
      { name: "Sunita Devi", email: "housekeeping@velurex.in", role: "housekeeping", pass: "house123", phone: "+91 98200 77889" },
      { name: "Vikram Singh", email: "restaurant@velurex.in", role: "restaurant_staff", pass: "rest123", phone: "+91 98200 99001" },
      { name: "Deepak Kumar", email: "deepak@velurex.in", role: "housekeeping", pass: "house123", phone: "+91 98200 22113" },
    ].map((s) =>
      db.staff.create({
        data: {
          propertyId: property.id,
          name: s.name,
          email: s.email,
          phone: s.phone,
          role: s.role,
          passwordHash: hashPassword(s.pass),
        },
      })
    )
  );
  const [admin, frontDesk, housekeeper, , housekeeper2] = staff;

  console.log("Creating room types & rooms…");
  const deluxe = await db.roomType.create({
    data: { propertyId: property.id, name: "Deluxe Room", code: "DLX", baseRate: 5500, maxOccupancy: 3, sizeSqft: 320, bedType: "King", description: "Elegant room with city views, work desk and rain shower.", amenities: JSON.stringify(["Wi-Fi", "Smart TV", "Mini Bar", "Rain Shower", "AC", "Work Desk"]) },
  });
  const superior = await db.roomType.create({
    data: { propertyId: property.id, name: "Superior Room", code: "SUP", baseRate: 4200, maxOccupancy: 2, sizeSqft: 260, bedType: "Queen", description: "Comfortable room ideal for solo travelers and couples.", amenities: JSON.stringify(["Wi-Fi", "Smart TV", "AC", "Tea/Coffee Maker"]) },
  });
  const suite = await db.roomType.create({
    data: { propertyId: property.id, name: "Executive Suite", code: "EXS", baseRate: 9500, maxOccupancy: 4, sizeSqft: 540, bedType: "King", description: "Separate living room, sea views and complimentary laundry.", amenities: JSON.stringify(["Wi-Fi", "Living Room", "Sea View", "Bathtub", "Mini Bar", "Butler Service"]) },
  });
  const presidential = await db.roomType.create({
    data: { propertyId: property.id, name: "Presidential Suite", code: "PRS", baseRate: 18000, maxOccupancy: 4, sizeSqft: 980, bedType: "King", description: "Top-floor suite with private terrace and dining pantry.", amenities: JSON.stringify(["Private Terrace", "Jacuzzi", "Butler Service", "Dining Pantry", "Sea View", "Wi-Fi"]) },
  });

  const roomDefs: { number: string; floor: number; typeId: string }[] = [];
  // Floor 1: 101-107 (Superior + Deluxe)
  for (let i = 1; i <= 7; i++) roomDefs.push({ number: `10${i}`, floor: 1, typeId: i <= 3 ? superior.id : deluxe.id });
  // Floor 2: 201-207 (Deluxe)
  for (let i = 1; i <= 7; i++) roomDefs.push({ number: `20${i}`, floor: 2, typeId: deluxe.id });
  // Floor 3: 301-306 (Suites + 2 Presidential)
  for (let i = 1; i <= 4; i++) roomDefs.push({ number: `30${i}`, floor: 3, typeId: suite.id });
  roomDefs.push({ number: "305", floor: 3, typeId: presidential.id });
  roomDefs.push({ number: "306", floor: 3, typeId: presidential.id });

  const rooms = await Promise.all(
    roomDefs.map((r) =>
      db.room.create({ data: { propertyId: property.id, roomTypeId: r.typeId, number: r.number, floor: r.floor } })
    )
  );

  console.log("Creating rate plans…");
  const bar = await db.ratePlan.create({ data: { propertyId: property.id, name: "Best Available Rate", code: "BAR", baseRate: 0, inclusions: "Room only", description: "Flexible standard rate" } });
  const bnb = await db.ratePlan.create({ data: { propertyId: property.id, name: "Bed & Breakfast", code: "BNB", baseRate: 800, inclusions: "Breakfast, Wi-Fi", description: "Stay with morning breakfast buffet" } });
  const weekend = await db.ratePlan.create({ data: { propertyId: property.id, name: "Weekend Bliss", code: "WKND", baseRate: 0, weekendRate: 6800, inclusions: "Breakfast, Late checkout 2 PM", description: "Fri–Sun stays with late checkout" } });
  const monsoon = await db.ratePlan.create({
    data: { propertyId: property.id, name: "Monsoon Package", code: "MNSN", baseRate: 4800, seasonalStart: day(-60), seasonalEnd: day(60), seasonalRate: 4800, inclusions: "Breakfast, Dinner, Masala chai on arrival", description: "Seasonal saver package" },
  });

  console.log("Creating guests…");
  const guestData = [
    { fullName: "Priya Sharma", phone: "+91 98111 22334", email: "priya.s@gmail.com", idType: "aadhaar", idNumber: "4321 8890 1122", city: "Mumbai", address: "B-702, Hiranandani, Powai" },
    { fullName: "Amit Verma", phone: "+91 98222 33445", email: "amit.verma@yahoo.in", idType: "passport", idNumber: "M8123456", city: "Delhi", address: "12 Golf Links" },
    { fullName: "Sneha Patel", phone: "+91 98333 44556", email: "sneha.patel@gmail.com", idType: "aadhaar", idNumber: "5678 1234 9012", city: "Ahmedabad" },
    { fullName: "Rohit Singh", phone: "+91 98444 55667", email: "rohit.singh@outlook.com", idType: "dl", idNumber: "MH1220110045678", city: "Pune" },
    { fullName: "Neha Gupta", phone: "+91 98555 66778", email: "neha.g@gmail.com", idType: "aadhaar", idNumber: "9012 3456 7890", city: "Jaipur" },
    { fullName: "Arjun Nair", phone: "+91 98666 77889", email: "arjun.nair@gmail.com", idType: "passport", idNumber: "N9988776", city: "Kochi" },
    { fullName: "Kavita Reddy", phone: "+91 98777 88990", email: "kavita.r@gmail.com", idType: "aadhaar", idNumber: "2345 6789 0123", city: "Hyderabad" },
    { fullName: "Sanjay Iyer", phone: "+91 98888 99001", email: "sanjay.iyer@gmail.com", idType: "pan", idNumber: "AKQPI1234F", city: "Chennai" },
    { fullName: "Divya Kapoor", phone: "+91 98999 00112", email: "divya.k@gmail.com", idType: "aadhaar", idNumber: "6789 0123 4567", city: "Lucknow" },
    { fullName: "Karan Malhotra", phone: "+91 98000 11223", email: "karan.m@gmail.com", idType: "passport", idNumber: "K7654321", city: "Bengaluru" },
  ];
  const guests = await Promise.all(guestData.map((g) => db.guest.create({ data: { ...g, propertyId: property.id } })));

  console.log("Creating reservations…");
  let conf = 1000;
  async function makeReservation(o: {
    guestId: string; roomId?: string; roomTypeId?: string; checkIn: Date; checkOut: Date;
    status: string; source?: string; rate?: number; adults?: number; paid?: number; notes?: string; groupCode?: string; ratePlanId?: string;
  }) {
    const n = nights(o.checkIn, o.checkOut);
    const rate = o.rate ?? 5500;
    conf++;
    return db.reservation.create({
      data: {
        propertyId: property.id,
        confirmationNumber: `RG-${conf}`,
        guestId: o.guestId,
        roomId: o.roomId ?? null,
        roomTypeId: o.roomTypeId ?? null,
        status: o.status,
        source: o.source ?? "front_desk",
        checkIn: o.checkIn,
        checkOut: o.checkOut,
        nights: n,
        adults: o.adults ?? 2,
        ratePlanId: o.ratePlanId ?? bnb.id,
        nightlyRate: rate,
        totalAmount: n * rate,
        paidAmount: o.paid ?? 0,
        notes: o.notes ?? "",
        groupCode: o.groupCode ?? "",
        checkedInAt: o.status === "checked_in" ? o.checkIn : null,
        checkedOutAt: o.status === "checked_out" ? o.checkOut : null,
      },
    });
  }

  const roomByNumber = Object.fromEntries(rooms.map((r) => [r.number, r]));

  // ── In-house guests (checked_in → occupied rooms)
  const r1 = await makeReservation({ guestId: guests[0].id, roomId: roomByNumber["102"].id, roomTypeId: deluxe.id, checkIn: day(-1), checkOut: day(2), status: "checked_in", rate: 5500, paid: 5000, source: "booking_engine" });
  const r2 = await makeReservation({ guestId: guests[1].id, roomId: roomByNumber["103"].id, roomTypeId: deluxe.id, checkIn: day(-2), checkOut: day(0, 23), status: "checked_in", rate: 5500, paid: 0, source: "walk_in", adults: 2 });
  const r3 = await makeReservation({ guestId: guests[3].id, roomId: roomByNumber["105"].id, roomTypeId: deluxe.id, checkIn: day(-1), checkOut: day(3), status: "checked_in", rate: 5500, paid: 16500 });
  const r4 = await makeReservation({ guestId: guests[4].id, roomId: roomByNumber["106"].id, roomTypeId: deluxe.id, checkIn: day(0), checkOut: day(2), status: "checked_in", rate: 5500, paid: 0, source: "phone" });
  const r5 = await makeReservation({ guestId: guests[5].id, roomId: roomByNumber["301"].id, roomTypeId: suite.id, checkIn: day(-3), checkOut: day(1), status: "checked_in", rate: 9500, paid: 19000, adults: 3 });
  const r6 = await makeReservation({ guestId: guests[6].id, roomId: roomByNumber["303"].id, roomTypeId: suite.id, checkIn: day(-1), checkOut: day(4), status: "checked_in", rate: 9500, paid: 10000, source: "ota" });
  const r13 = await makeReservation({ guestId: guests[7].id, roomId: roomByNumber["201"].id, roomTypeId: deluxe.id, checkIn: day(-2), checkOut: day(1), status: "checked_in", rate: 5500, paid: 11000, source: "ota", adults: 1 });
  const r14 = await makeReservation({ guestId: guests[8].id, roomId: roomByNumber["202"].id, roomTypeId: deluxe.id, checkIn: day(0), checkOut: day(2), status: "checked_in", rate: 5500, paid: 2750, source: "walk_in", adults: 2 });
  const r15 = await makeReservation({ guestId: guests[9].id, roomId: roomByNumber["302"].id, roomTypeId: suite.id, checkIn: day(-1), checkOut: day(2), status: "checked_in", rate: 9500, paid: 9500, adults: 2 });

  // ── Arrivals today / upcoming (confirmed)
  const r7 = await makeReservation({ guestId: guests[7].id, roomId: roomByNumber["203"].id, roomTypeId: deluxe.id, checkIn: day(0), checkOut: day(2), status: "confirmed", rate: 5500, paid: 5500, source: "booking_engine" });
  const r8 = await makeReservation({ guestId: guests[8].id, roomId: roomByNumber["204"].id, roomTypeId: deluxe.id, checkIn: day(0), checkOut: day(3), status: "confirmed", rate: 5500, paid: 0, notes: "Honeymoon — flower decoration requested" });
  const r9 = await makeReservation({ guestId: guests[9].id, roomId: roomByNumber["305"].id, roomTypeId: presidential.id, checkIn: day(1), checkOut: day(4), status: "confirmed", rate: 18000, paid: 36000, source: "ota" });
  const r10 = await makeReservation({ guestId: guests[2].id, roomId: roomByNumber["203"].id, roomTypeId: deluxe.id, checkIn: day(2), checkOut: day(5), status: "confirmed", rate: 5500 });
  const r11 = await makeReservation({ guestId: guests[1].id, roomId: roomByNumber["204"].id, roomTypeId: deluxe.id, checkIn: day(3), checkOut: day(6), status: "hold", rate: 5500, notes: "Awaiting corporate approval — hold till 6 PM" });
  const r12 = await makeReservation({ guestId: guests[0].id, roomId: roomByNumber["205"].id, roomTypeId: deluxe.id, checkIn: day(4), checkOut: day(7), status: "confirmed", rate: 5500, source: "booking_engine" });

  // ── Group booking (3 rooms, same code)
  await makeReservation({ guestId: guests[6].id, roomId: roomByNumber["206"].id, roomTypeId: deluxe.id, checkIn: day(5), checkOut: day(8), status: "confirmed", rate: 5200, groupCode: "GRP-CONF-09", adults: 2 });
  await makeReservation({ guestId: guests[7].id, roomId: roomByNumber["207"].id, roomTypeId: deluxe.id, checkIn: day(5), checkOut: day(8), status: "confirmed", rate: 5200, groupCode: "GRP-CONF-09", adults: 2 });
  await makeReservation({ guestId: guests[8].id, roomId: roomByNumber["302"].id, roomTypeId: suite.id, checkIn: day(5), checkOut: day(8), status: "confirmed", rate: 9100, groupCode: "GRP-CONF-09", adults: 2 });

  // ── History (checked_out)
  await makeReservation({ guestId: guests[2].id, roomId: roomByNumber["101"].id, roomTypeId: superior.id, checkIn: day(-6), checkOut: day(-3), status: "checked_out", rate: 4200, paid: 12600, source: "walk_in" });
  await makeReservation({ guestId: guests[3].id, roomId: roomByNumber["104"].id, roomTypeId: deluxe.id, checkIn: day(-5), checkOut: day(-4), status: "checked_out", rate: 5500, paid: 5500 });
  await makeReservation({ guestId: guests[9].id, roomId: roomByNumber["304"].id, roomTypeId: suite.id, checkIn: day(-8), checkOut: day(-5), status: "checked_out", rate: 9500, paid: 28500 });

  // ── Cancelled + past no-show candidate (confirmed with check-in 2 days ago, no check-in → night audit will flag)
  await makeReservation({ guestId: guests[4].id, roomId: roomByNumber["101"].id, roomTypeId: superior.id, checkIn: day(-2), checkOut: day(1), status: "cancelled", rate: 4200 });
  await makeReservation({ guestId: guests[5].id, roomId: roomByNumber["306"].id, roomTypeId: presidential.id, checkIn: day(-1), checkOut: day(2), status: "confirmed", rate: 18000, paid: 0, notes: "Guaranteed booking — no advance received" });

  // ── Folio items for in-house guests
  console.log("Creating folio items & payments…");
  const folioDefs: { res: any; category: string; description: string; qty: number; rate: number; offset: number }[] = [
    { res: r1, category: "room", description: "Room charge — Deluxe 102", qty: 1, rate: 5500, offset: -1 },
    { res: r1, category: "fnb", description: "Restaurant — Dinner buffet", qty: 2, rate: 1250, offset: -1 },
    { res: r1, category: "laundry", description: "Laundry — 3 pieces", qty: 3, rate: 120, offset: 0 },
    { res: r2, category: "room", description: "Room charge — Deluxe 103", qty: 2, rate: 5500, offset: -2 },
    { res: r2, category: "bar", description: "Bar — Beverages", qty: 4, rate: 450, offset: -1 },
    { res: r3, category: "room", description: "Room charge — Deluxe 105", qty: 1, rate: 5500, offset: -1 },
    { res: r5, category: "room", description: "Room charge — Executive Suite 301", qty: 3, rate: 9500, offset: -3 },
    { res: r5, category: "misc", description: "Airport pickup", qty: 1, rate: 1500, offset: -3 },
    { res: r6, category: "room", description: "Room charge — Executive Suite 303", qty: 1, rate: 9500, offset: -1 },
    { res: r13, category: "room", description: "Room charge — Deluxe 201", qty: 2, rate: 5500, offset: -2 },
    { res: r14, category: "room", description: "Room charge — Deluxe 202", qty: 1, rate: 5500, offset: 0 },
    { res: r15, category: "room", description: "Room charge — Executive Suite 302", qty: 1, rate: 9500, offset: -1 },
  ];
  for (const f of folioDefs) {
    await db.folioItem.create({
      data: {
        propertyId: property.id, reservationId: f.res.id, guestId: f.res.guestId,
        category: f.category, description: f.description, qty: f.qty, rate: f.rate,
        amount: f.qty * f.rate, businessDate: day(f.offset), postedBy: frontDesk.name,
      },
    });
  }
  // Today's revenue mix: room charges for every in-house guest + F&B activity
  const inHouseRes = [r1, r2, r3, r4, r5, r6, r13, r14, r15];
  for (const res of inHouseRes) {
    const rm = rooms.find((r) => r.id === res.roomId);
    await db.folioItem.create({
      data: {
        propertyId: property.id, reservationId: res.id, guestId: res.guestId,
        category: "room", description: `Room charge — ${rm?.number}` , qty: 1, rate: res.nightlyRate,
        amount: res.nightlyRate, businessDate: day(0), postedBy: frontDesk.name,
      },
    });
  }
  await db.folioItem.createMany({
    data: [
      { propertyId: property.id, reservationId: r1.id, guestId: r1.guestId, category: "fnb", description: "Restaurant — Breakfast buffet", qty: 2, rate: 850, amount: 1700, businessDate: day(0), postedBy: "Vikram Singh" },
      { propertyId: property.id, reservationId: r2.id, guestId: r2.guestId, category: "bar", description: "Bar — Evening beverages", qty: 3, rate: 450, amount: 1350, businessDate: day(0), postedBy: "Vikram Singh" },
      { propertyId: property.id, reservationId: r3.id, guestId: r3.guestId, category: "laundry", description: "Laundry — Express service", qty: 5, rate: 120, amount: 600, businessDate: day(0), postedBy: frontDesk.name },
      { propertyId: property.id, reservationId: r5.id, guestId: r5.guestId, category: "misc", description: "Spa session — Ayurvedic", qty: 1, rate: 2800, amount: 2800, businessDate: day(0), postedBy: frontDesk.name },
    ],
  });

  // ── Restaurant menu
  console.log("Creating menu & POS orders…");
  const menuData = [
    { name: "Paneer Tikka", category: "starter", price: 320, isVeg: true, description: "Char-grilled cottage cheese, mint chutney" },
    { name: "Chicken Seekh Kebab", category: "starter", price: 380, isVeg: false, description: "Minced chicken skewers, saffron aioli" },
    { name: "Tandoori Prawns", category: "starter", price: 520, isVeg: false, description: "Konkan prawns, kokum glaze" },
    { name: "Dal Makhani", category: "main", price: 340, isVeg: true, description: "Slow-cooked black lentils, white butter" },
    { name: "Butter Chicken", category: "main", price: 460, isVeg: false, description: "Tomato-cream gravy, tandoori chicken" },
    { name: "Malabar Fish Curry", category: "main", price: 540, isVeg: false, description: "Coconut curry, appam" },
    { name: "Veg Biryani", category: "main", price: 380, isVeg: true, description: "Dum-cooked basmati, raita" },
    { name: "Hyderabadi Mutton Biryani", category: "main", price: 520, isVeg: false, description: "Long-grain basmati, burani raita" },
    { name: "Butter Naan", category: "main", price: 80, isVeg: true, description: "Tandoor fresh" },
    { name: "Gulab Jamun", category: "dessert", price: 160, isVeg: true, description: "Warm, rose syrup" },
    { name: "Rasmalai", category: "dessert", price: 180, isVeg: true, description: "Saffron milk, pistachio" },
    { name: "Chocolate Fondant", category: "dessert", price: 280, isVeg: true, description: "Vanilla bean ice cream" },
    { name: "Masala Chai", category: "beverage", price: 120, isVeg: true, description: "Ginger, cardamom" },
    { name: "Fresh Lime Soda", category: "beverage", price: 140, isVeg: true, description: "Sweet / salted / mixed" },
    { name: "Cold Coffee", category: "beverage", price: 220, isVeg: true, description: "Ice cream blend" },
    { name: "Kingfisher Ultra", category: "bar", price: 350, isVeg: true, description: "330 ml" },
    { name: "Old Fashioned", category: "bar", price: 550, isVeg: true, description: "Bourbon, bitters, orange" },
    { name: "Wine — Sula Riesling", category: "bar", price: 650, isVeg: true, description: "Glass" },
  ];
  const menuItems = await Promise.all(
    menuData.map((m, i) => db.menuItem.create({ data: { ...m, propertyId: property.id, sortOrder: i, taxRate: 5 } }))
  );

  // A settled dine-in order from yesterday + a live room-service order posted to folio
  const ord1 = await db.posOrder.create({
    data: {
      propertyId: property.id, orderNumber: "ORD-1001", orderType: "dine_in", tableNumber: "T4",
      status: "completed", servedBy: "Vikram Singh", paymentStatus: "paid", paymentMethod: "upi",
      subtotal: 1120, taxAmount: 56, totalAmount: 1176, createdAt: day(-1, 20),
    },
  });
  await db.posOrderItem.createMany({
    data: [
      { orderId: ord1.id, menuItemId: menuItems[3].id, name: "Dal Makhani", qty: 2, price: 340, amount: 680, status: "served" },
      { orderId: ord1.id, menuItemId: menuItems[8].id, name: "Butter Naan", qty: 4, price: 80, amount: 320, status: "served" },
      { orderId: ord1.id, menuItemId: menuItems[9].id, name: "Gulab Jamun", qty: 1, price: 160, amount: 160, status: "served" },
    ],
  });
  await db.payment.create({ data: { propertyId: property.id, posOrderId: ord1.id, amount: 1176, method: "upi", reference: "UPI/923456781", receivedBy: "Vikram Singh", createdAt: day(-1, 20) } });

  const ord2 = await db.posOrder.create({
    data: {
      propertyId: property.id, orderNumber: "ORD-1002", orderType: "room_service", roomNumber: "102",
      reservationId: r1.id, guestName: "Priya Sharma", status: "served",
      subtotal: 920, taxAmount: 46, totalAmount: 966,
    },
  });
  await db.posOrderItem.createMany({
    data: [
      { orderId: ord2.id, menuItemId: menuItems[0].id, name: "Paneer Tikka", qty: 1, price: 320, amount: 320, status: "served" },
      { orderId: ord2.id, menuItemId: menuItems[7].id, name: "Hyderabadi Mutton Biryani", qty: 1, price: 520, amount: 520, status: "served" },
      { orderId: ord2.id, menuItemId: menuItems[12].id, name: "Masala Chai", qty: 1, price: 120, amount: 120, status: "served" },
    ],
  });

  // ── Housekeeping tasks
  console.log("Creating housekeeping & maintenance…");
  const taskDefs = [
    { room: "102", type: "cleaning", priority: "high", status: "pending", due: 11, assign: housekeeper.id, notes: "Checkout due tomorrow — deep clean" },
    { room: "103", type: "linen_change", priority: "normal", status: "in_progress", due: 12, assign: housekeeper.id, notes: "" },
    { room: "105", type: "bathroom", priority: "normal", status: "pending", due: 13, assign: housekeeper2.id, notes: "Guest requested extra towels" },
    { room: "106", type: "cleaning", priority: "high", status: "pending", due: 10, assign: housekeeper.id, notes: "Arrival today 3 PM" },
    { room: "201", type: "inspection", priority: "normal", status: "completed", due: 9, assign: housekeeper2.id, notes: "" },
    { room: "202", type: "cleaning", priority: "normal", status: "completed", due: 9, assign: housekeeper.id, notes: "" },
    { room: "203", type: "cleaning", priority: "normal", status: "pending", due: 15, assign: housekeeper2.id, notes: "Ready for arrival on day after" },
    { room: "301", type: "turndown", priority: "low", status: "pending", due: 19, assign: housekeeper2.id, notes: "Evening turndown service" },
    { room: "303", type: "cleaning", priority: "normal", status: "in_progress", due: 14, assign: housekeeper.id, notes: "" },
    { room: "104", type: "cleaning", priority: "high", status: "pending", due: 11, assign: housekeeper2.id, notes: "Post-checkout clean — prioritize" },
    { room: "204", type: "cleaning", priority: "high", status: "pending", due: 11, assign: housekeeper.id, notes: "Arrival today — priority clean" },
  ];
  for (const t of taskDefs) {
    await db.housekeepingTask.create({
      data: {
        propertyId: property.id, roomId: roomByNumber[t.room].id, assignedTo: t.assign,
        taskType: t.type, priority: t.priority, status: t.status,
        dueAt: day(0, t.due), notes: t.notes,
        completedAt: t.status === "completed" ? day(0, 9) : null,
      },
    });
  }
  // mark occupied rooms
  for (const num of ["102", "103", "105", "106", "201", "202", "301", "302", "303"]) {
    await db.room.update({ where: { id: roomByNumber[num].id }, data: { status: "occupied" } });
  }
  await db.room.update({ where: { id: roomByNumber["104"].id }, data: { status: "dirty" } });
  await db.room.update({ where: { id: roomByNumber["203"].id }, data: { status: "clean" } });
  await db.room.update({ where: { id: roomByNumber["305"].id }, data: { status: "out_of_order", note: "AC compressor replacement" } });

  await db.maintenanceTicket.createMany({
    data: [
      { propertyId: property.id, roomId: roomByNumber["305"].id, title: "AC not cooling", description: "Compressor noise, room warm. Technician called.", priority: "high", status: "in_progress", reportedBy: frontDesk.name },
      { propertyId: property.id, roomId: roomByNumber["103"].id, title: "Dripping bathroom tap", description: "Slow leak under washbasin.", priority: "normal", status: "open", reportedBy: housekeeper.name },
      { propertyId: property.id, roomId: null, title: "Poolside lounger broken", description: "Two loungers cracked near pool deck.", priority: "low", status: "open", reportedBy: admin.name },
    ],
  });

  // ── Promo codes
  console.log("Creating promos & audit history…");
  await db.promoCode.createMany({
    data: [
      { propertyId: property.id, code: "EARLY15", description: "15% off early bookings", discountType: "percent", discountValue: 15, validFrom: day(-30), validTo: day(60), maxUses: 200 },
      { propertyId: property.id, code: "MONSOON500", description: "Flat ₹500 off", discountType: "flat", discountValue: 500, validFrom: day(-30), validTo: day(45), maxUses: 100, usedCount: 12 },
    ],
  });

  // ── Night audit history (last 5 business days)
  const totalRooms = rooms.length;
  const hist = [
    { offset: -7, occ: 50, roomRev: 68000, fnb: 19800, misc: 2400 },
    { offset: -6, occ: 55, roomRev: 69500, fnb: 21400, misc: 2900 },
    { offset: -5, occ: 55, roomRev: 71500, fnb: 22400, misc: 3100 },
    { offset: -4, occ: 60, roomRev: 76000, fnb: 25100, misc: 1800 },
    { offset: -3, occ: 65, roomRev: 86500, fnb: 28900, misc: 4200 },
    { offset: -2, occ: 70, roomRev: 91000, fnb: 31200, misc: 2600 },
    { offset: -1, occ: 70, roomRev: 95500, fnb: 33400, misc: 3900 },
  ];
  for (const h of hist) {
    const occupied = Math.round((h.occ / 100) * totalRooms);
    const adr = h.roomRev / occupied;
    await db.nightAuditLog.create({
      data: {
        propertyId: property.id, businessDate: day(h.offset), runBy: admin.id, runByName: admin.name,
        runAt: day(h.offset, 23), totalRevenue: h.roomRev + h.fnb + h.misc, roomRevenue: h.roomRev,
        fnbRevenue: h.fnb, miscRevenue: h.misc, occupancyPercent: h.occ, adr, revpar: h.roomRev / totalRooms,
        occupiedRooms: occupied, totalRooms, noShowCount: h.offset === -4 ? 1 : 0, noShowCharges: h.offset === -4 ? 4200 : 0,
        outstandingBalance: 24000 + (h.offset % 3) * 8000,
      },
    });
  }

  // ── WhatsApp + activity log samples
  await db.whatsAppMessage.createMany({
    data: [
      { propertyId: property.id, toPhone: "+91 98111 22334", templateName: "booking_confirmation", body: "Hi Priya! Your booking RG-1001 at The Royal Grand Hotel is confirmed. Check-in 25 Sep. — 10:24 AM", status: "mock", reservationId: r1.id, createdAt: day(-3, 10) },
      { propertyId: property.id, toPhone: "+91 98777 88990", templateName: "pre_arrival", body: "Kavita, we look forward to welcoming you tomorrow. Arrive after 2 PM. Reply for airport pickup.", status: "mock", reservationId: r6.id, createdAt: day(-1, 18) },
    ],
  });
  await db.activityLog.create({
    data: { propertyId: property.id, staffId: frontDesk.id, staffName: frontDesk.name, action: "CHECK_IN", entity: "reservation", entityId: r1.id, details: "Priya Sharma checked into Deluxe 102", createdAt: day(-1, 14) },
  });

  // ── SaaS platform layer: plans, owner, businesses, subscriptions, billing…
  await seedPlatform(property);

  console.log("✅ Seed complete.");
  console.log("   Property:", property.name, `(${rooms.length} rooms)`);
  console.log("   Logins: admin@velurex.in/admin123 · frontdesk@velurex.in/front123 · housekeeping@velurex.in/house123 · restaurant@velurex.in/rest123");
  console.log("   Platform owner: owner@velurex.in/owner123");
}

/* ═════════════════════════ SaaS platform seed ═════════════════════════ */

function planFeatures(o: Record<string, unknown>) {
  return JSON.stringify({
    rooms: 20, staff: 5, properties: 1, ota_channels: 2, whatsapp_msgs: 0,
    pos: false, night_audit: false, whatsapp_automation: false, dynamic_pricing: false,
    advanced_reports: false, excel_export: false, api_access: false, white_label: false,
    multi_property: false, support: "email", backup: "weekly",
    ...o,
  });
}

async function seedPlatform(royalGrand: { id: string }) {
  console.log("Seeding SaaS platform layer…");
  const enc = (v: unknown) => encryptJSON(v);

  // ── Plans (features JSON is the single source of truth — never hard-coded)
  const basic = await db.plan.create({ data: {
    code: "basic", name: "Basic", description: "Everything a small hotel needs to go digital.",
    monthlyPrice: 4999, sortOrder: 1,
    features: planFeatures({ support: "email", backup: "weekly" }),
  }});
  const pro = await db.plan.create({ data: {
    code: "pro", name: "Pro", description: "POS, night audit, WhatsApp automation and advanced reports.",
    monthlyPrice: 9999, sortOrder: 2,
    features: planFeatures({ rooms: 60, staff: 15, properties: 5, ota_channels: 5, whatsapp_msgs: 500,
      pos: true, night_audit: true, whatsapp_automation: true, advanced_reports: true, excel_export: true,
      support: "email_chat", backup: "daily" }),
  }});
  await db.plan.create({ data: {
    code: "enterprise", name: "Enterprise", description: "Unlimited scale, dynamic pricing, white-label and API access.",
    monthlyPrice: 19999, sortOrder: 3,
    features: planFeatures({ rooms: -1, staff: -1, properties: -1, ota_channels: -1, whatsapp_msgs: 2000,
      pos: true, night_audit: true, whatsapp_automation: true, dynamic_pricing: true, advanced_reports: true,
      excel_export: true, api_access: true, white_label: true, multi_property: true,
      support: "priority", backup: "daily_on_demand" }),
  }});

  // ── Platform owner account (demo — the real owner is seeded by seed-real-account.ts)
  await db.platformUser.create({ data: {
    name: "Velurex Platform Owner", email: "owner@velurex.in",
    passwordHash: hashPassword("owner123"), role: "software_owner", isDemo: true,
  }});

  // ── Three more businesses across plans / statuses
  const mkBusiness = async (o: {
    name: string; city: string; state: string; type: string; category: string;
    roomCount: number; adminName: string; adminEmail: string; health: number;
  }) => {
    const p = await db.property.create({ data: {
      name: o.name, address: `${o.city}`, city: o.city, state: o.state,
      propertyType: o.type, businessCategory: o.category,
      phone: "+91 98400 00000", email: `reservations@${o.adminEmail.split("@")[1]}`,
      gstin: "", businessDate: day(0), isDemo: true, // seed demo tenant
    }});
    await db.staff.create({ data: {
      propertyId: p.id, name: o.adminName, email: o.adminEmail,
      role: "hotel_admin", passwordHash: hashPassword("admin123"),
    }});
    const rt = await db.roomType.create({ data: {
      propertyId: p.id, name: "Standard Room", code: "STD", baseRate: 2800, maxOccupancy: 2,
    }});
    await db.room.createMany({ data: Array.from({ length: o.roomCount }, (_, i) => ({
      propertyId: p.id, roomTypeId: rt.id, number: `${100 + i + 1}`, floor: 1, status: "clean",
    }))});
    return p;
  };

  const greenValley = await mkBusiness({ name: "Green Valley Resort", city: "Coorg", state: "Karnataka",
    type: "Resort", category: "Leisure Resort", roomCount: 8, adminName: "Amit Rao",
    adminEmail: "amit@greenvalley.in", health: 84 });
  const sunrise = await mkBusiness({ name: "Sunrise Homestay", city: "Jaipur", state: "Rajasthan",
    type: "Homestay", category: "Boutique Homestay", roomCount: 4, adminName: "Neha Kulkarni",
    adminEmail: "neha@sunrisehomestay.in", health: 65 });
  const harbour = await mkBusiness({ name: "Harbour View Boutique", city: "Kochi", state: "Kerala",
    type: "Hotel", category: "Boutique Hotel", roomCount: 12, adminName: "Ravi Menon",
    adminEmail: "ravi@harbourview.in", health: 48 });

  // ── Subscriptions (royal grand passed in)
  const GST = 18;

  const subRoyal = await db.subscription.create({ data: {
    propertyId: royalGrand.id, planId: pro.id, cycle: "yearly", status: "active",
    startedAt: day(-320), renewalAt: day(45), autoRenew: true,
  }});
  const subGreen = await db.subscription.create({ data: {
    propertyId: greenValley.id, planId: basic.id, cycle: "monthly", status: "active",
    startedAt: day(-140), renewalAt: day(16), autoRenew: true,
  }});
  const subSunrise = await db.subscription.create({ data: {
    propertyId: sunrise.id, planId: basic.id, cycle: "monthly", status: "trial",
    startedAt: day(-4), trialEndsAt: day(10), renewalAt: day(10), autoRenew: true,
  }});
  await db.subscription.create({ data: {
    propertyId: harbour.id, planId: basic.id, cycle: "monthly", status: "overdue",
    startedAt: day(-200), renewalAt: day(-5), autoRenew: true,
    notes: "Payment failed on 1st attempt — reminder sent via WhatsApp.",
  }});
  await db.subscriptionAddon.create({ data: {
    propertyId: royalGrand.id, addonKey: "whatsapp_pack", label: "WhatsApp Pack +200 msgs/mo", qty: 1, price: 499,
  }});
  await db.subscriptionAddon.create({ data: {
    propertyId: greenValley.id, addonKey: "rooms_pack", label: "Extra Rooms Pack (+10 rooms)", qty: 1, price: 999,
  }});
  await db.featureOverride.create({ data: {
    propertyId: sunrise.id, featureKey: "whatsapp_automation", enabled: true,
    note: "Founder deal — WhatsApp automation free during trial.",
  }});

  // ── Invoices (sequential numbers, GST 18%)
  let invSeq = 1;
  const mkInvoice = async (o: {
    propertyId: string; subscriptionId: string; status: string; type?: string;
    description: string; unitPrice: number; periodStart: number; periodEnd: number;
    dueInDays?: number; method?: string; couponCode?: string; discountAmount?: number;
  }) => {
    const subtotal = o.unitPrice;
    const discount = o.discountAmount ?? 0;
    const taxable = Math.max(0, subtotal - discount);
    const tax = taxable * (GST / 100);
    const inv = await db.invoice.create({ data: {
      number: `VXL-2025-${String(invSeq++).padStart(4, "0")}`,
      propertyId: o.propertyId, subscriptionId: o.subscriptionId, type: o.type ?? "subscription",
      status: o.status, subtotal, discountAmount: discount, taxAmount: Math.round(tax * 100) / 100,
      totalAmount: Math.round((taxable + tax) * 100) / 100,
      couponCode: o.couponCode ?? "",
      periodStart: day(o.periodStart), periodEnd: day(o.periodEnd),
      dueDate: day((o.dueInDays ?? 0)), paidAt: o.status === "paid" ? day(o.periodEnd, 10) : null,
      notes: o.status === "overdue" ? "Auto-reminder sent 3 times." : "",
    }});
    await db.invoiceItem.create({ data: {
      invoiceId: inv.id, description: o.description, qty: 1, unitPrice: subtotal, taxRate: GST, amount: subtotal,
    }});
    if (o.status === "paid") {
      await db.platformPayment.create({ data: {
        invoiceId: inv.id, propertyId: o.propertyId, amount: inv.totalAmount,
        method: o.method ?? "razorpay", status: "success", reference: `pay_seed_${invSeq}`,
        paidAt: day(o.periodEnd, 10), receivedBy: "auto-collect",
      }});
    }
    return inv;
  };

  // Royal Grand — 10 months of history on yearly Pro
  for (let i = 3; i >= 1; i--) {
    await mkInvoice({ propertyId: royalGrand.id, subscriptionId: subRoyal.id, status: "paid",
      description: "Pro Plan — Yearly (instalment)", unitPrice: 9999,
      periodStart: -30 * i - 30, periodEnd: -30 * i, method: "bank" });
  }
  await mkInvoice({ propertyId: royalGrand.id, subscriptionId: subRoyal.id, status: "paid",
    description: "Pro Plan — Yearly (instalment)", unitPrice: 9999, periodStart: -30, periodEnd: 0, method: "razorpay" });
  // Green Valley — monthly Basic, 3 paid + 1 upcoming
  for (let i = 4; i >= 2; i--) {
    await mkInvoice({ propertyId: greenValley.id, subscriptionId: subGreen.id, status: "paid",
      description: "Basic Plan — Monthly", unitPrice: 4999, periodStart: -30 * i, periodEnd: -30 * (i - 1) });
  }
  await mkInvoice({ propertyId: greenValley.id, subscriptionId: subGreen.id, status: "pending",
    description: "Basic Plan — Monthly", unitPrice: 4999, periodStart: -14, periodEnd: 16, dueInDays: 16 });
  // Harbour — overdue
  await mkInvoice({ propertyId: harbour.id, subscriptionId: subGreen.id,
    status: "paid", description: "Basic Plan — Monthly", unitPrice: 4999,
    periodStart: -60, periodEnd: -30 });
  const invHarbour = await mkInvoice({ propertyId: harbour.id, subscriptionId: subGreen.id, status: "overdue",
    description: "Basic Plan — Monthly", unitPrice: 4999, periodStart: -35, periodEnd: -5, dueInDays: -5 });
  await mkInvoice({ propertyId: sunrise.id, subscriptionId: subSunrise.id, status: "pending", type: "manual",
    description: "Trial conversion — Basic Plan (preview)", unitPrice: 4999, periodStart: 10, periodEnd: 40, dueInDays: 10 });

  // ── Coupons
  const cWelcome = await db.coupon.create({ data: {
    code: "WELCOME10", description: "10% off first invoice — all plans",
    discountType: "percent", discountValue: 10, maxUses: 200, usedCount: 1, validTo: day(90), isDemo: true,
  }});
  await db.coupon.create({ data: {
    code: "FLAT500", description: "₹500 off — Pro plan only",
    discountType: "flat", discountValue: 500, maxUses: 50, usedCount: 0, planCode: "pro", validTo: day(60), isDemo: true,
  }});
  await db.coupon.create({ data: {
    code: "TRIAL30", description: "Extend trial by 30 days",
    discountType: "percent", discountValue: 0, maxUses: 100, usedCount: 0, trialDays: 30, validTo: day(180), isDemo: true,
  }});
  await db.couponRedemption.create({ data: {
    couponId: cWelcome.id, propertyId: greenValley.id, invoiceId: invHarbour.id, createdAt: day(-100),
  }});

  // ── Support tickets
  const t1 = await db.supportTicket.create({ data: {
    propertyId: royalGrand.id, subject: "POS receipt printer not responding",
    category: "technical", priority: "urgent", status: "open",
    createdByName: "Rohan Mehta", assignedTo: "owner@velurex.in",
  }});
  await db.ticketMessage.createMany({ data: [
    { ticketId: t1.id, authorType: "tenant", authorName: "Rohan Mehta",
      body: "The Epson printer at the restaurant terminal stopped printing KOTs since last night. Orders are going through but nothing prints." },
    { ticketId: t1.id, authorType: "platform", authorName: "Velurex Support", internal: true,
      body: "Likely the Bluetooth pairing dropped again — ask them to reboot the router first before we escalate." },
  ]});
  const t2 = await db.supportTicket.create({ data: {
    propertyId: harbour.id, subject: "Card payment failed — invoice shows unpaid",
    category: "billing", priority: "high", status: "in_progress",
    createdByName: "Ravi Menon", assignedTo: "owner@velurex.in",
    firstResponseAt: day(-1), createdAt: day(-2),
  }});
  await db.ticketMessage.createMany({ data: [
    { ticketId: t2.id, authorType: "tenant", authorName: "Ravi Menon",
      body: "I tried paying the overdue invoice by card but it failed twice. Please share a fresh payment link.", createdAt: day(-2) },
    { ticketId: t2.id, authorType: "platform", authorName: "Velurex Support",
      body: "Sorry about that! We are generating a fresh Razorpay link and will WhatsApp it to you today.", createdAt: day(-1) },
  ]});
  const t3 = await db.supportTicket.create({ data: {
    propertyId: sunrise.id, subject: "How do I connect Booking.com?",
    category: "general", priority: "normal", status: "resolved",
    createdByName: "Neha Kulkarni", resolvedAt: day(-3), createdAt: day(-4),
  }});
  await db.ticketMessage.createMany({ data: [
    { ticketId: t3.id, authorType: "tenant", authorName: "Neha Kulkarni",
      body: "I want to push my 4 rooms to Booking.com. Where do I start?", createdAt: day(-4) },
    { ticketId: t3.id, authorType: "platform", authorName: "Velurex Support",
      body: "Go to Channels & OTAs → Add Channel → Booking.com, paste your hotel ID and API key. Our guide walks you through mapping room types. Note: OTA connections need 2+ on your plan.", createdAt: day(-3) },
  ]});

  // ── Announcement
  const ann = await db.announcement.create({ data: {
    title: "GST-compliant invoices are here 🎉",
    body: "Your Velurex subscription invoices now include GST breakdown and sequential invoice numbers. Download them anytime from My Subscription → Invoices.",
    audience: "all", channel: "in_app", createdBy: "owner@velurex.in", isDemo: true,
  }});

  // ── Leads pipeline
  await db.lead.createMany({ data: [
    { businessName: "Palm Beach Resort", contactName: "Sanjay Pillai", email: "sanjay@palmbeachgoa.in",
      phone: "+91 98221 44556", city: "Goa", status: "demo_requested", notes: "Wants demo next week — 34 rooms.", isDemo: true },
    { businessName: "Lakeview Inn", contactName: "Meera Joshi", email: "meera@lakeviewinn.in",
      phone: "+91 99887 12345", city: "Udaipur", status: "demo_done", notes: "Liked POS + WhatsApp. Waiting for owner sign-off.", isDemo: true },
    { businessName: "Backpacker Hostel Manali", contactName: "Joel Dsouza", email: "joel@bpmanali.in",
      phone: "+91 97112 88990", city: "Manali", status: "lost", notes: "Dorm-style pricing doesn't fit per-room model.", isDemo: true },
  ]});

  // ── Platform settings (sensitive = encrypted at rest, never returned in full)
  await db.platformSetting.createMany({ data: [
    { key: "default_trial_days", value: "14" },
    { key: "grace_days", value: "7" },
    { key: "suspend_retention_days", value: "60" },
    { key: "yearly_discount_percent", value: "10" },
    { key: "quarterly_discount_percent", value: "5" },
    { key: "gst_rate", value: "18" },
    { key: "company_gstin", value: "27AAACV1234F1Z5" },
    { key: "company_name", value: "Velurex Technologies Pvt Ltd" },
    { key: "terms_url", value: "https://velurex.in/terms" },
    { key: "privacy_url", value: "https://velurex.in/privacy" },
    { key: "razorpay_key_id", value: enc({ v: "rzp_live_VxL9a2bC4dE6f8" }), encrypted: true, updatedBy: "owner@velurex.in" },
    { key: "razorpay_key_secret", value: enc({ v: "rzp_secret_seed_do_not_use" }), encrypted: true, updatedBy: "owner@velurex.in" },
    { key: "whatsapp_phone_id", value: "109988776655443" },
    { key: "whatsapp_token", value: enc({ v: "EAAG_seed_whatsapp_token" }), encrypted: true, updatedBy: "owner@velurex.in" },
    { key: "smtp_host", value: "smtp.velurex.in" },
    { key: "smtp_user", value: "billing@velurex.in" },
    { key: "smtp_pass", value: enc({ v: "seed-smtp-secret" }), encrypted: true, updatedBy: "owner@velurex.in" },
  ]});

  // ── Property mirror columns + checklists + usage snapshots
  const mirror = async (propertyId: string, o: { planId: string; status: string; trialEndsAt?: Date; health: number; notes?: string }) => {
    await db.property.update({ where: { id: propertyId }, data: {
      currentPlanId: o.planId, subscriptionStatus: o.status, trialEndsAt: o.trialEndsAt ?? null,
      healthScore: o.health, notes: o.notes ?? "",
    }});
  };
  await mirror(royalGrand.id, { planId: pro.id, status: "active", health: 92 });
  await mirror(greenValley.id, { planId: basic.id, status: "active", health: 84 });
  await mirror(sunrise.id, { planId: basic.id, status: "trial", trialEndsAt: day(10), health: 65 });
  await mirror(harbour.id, { planId: basic.id, status: "overdue", health: 48, notes: "Overdue 5 days — call scheduled." });

  const today = new Date().toISOString().slice(0, 10);
  const counts = async (propertyId: string) => ({
    rooms: await db.room.count({ where: { propertyId } }),
    staff: await db.staff.count({ where: { propertyId } }),
    bookings: await db.reservation.count({ where: { propertyId } }),
    wa: await db.whatsAppMessage.count({ where: { propertyId } }),
  });
  for (const [pid, active] of [[royalGrand.id, true], [greenValley.id, true], [sunrise.id, true], [harbour.id, false]] as const) {
    const c = await counts(pid);
    await db.usageMetric.create({ data: {
      propertyId: pid, date: today, roomsUsed: c.rooms, staffUsed: c.staff,
      bookings: c.bookings, whatsappMsgs: c.wa, lastActiveAt: active ? new Date() : day(-6, 15),
    }});
  }

  await db.onboardingChecklist.createMany({ data: [
    { propertyId: royalGrand.id, roomsAdded: true, staffCreated: true, otaConnected: true, firstBooking: true, credentialsSent: true },
    { propertyId: greenValley.id, roomsAdded: true, staffCreated: true, otaConnected: false, firstBooking: true, credentialsSent: true },
    { propertyId: sunrise.id, roomsAdded: true, staffCreated: true, otaConnected: false, firstBooking: false, credentialsSent: true },
    { propertyId: harbour.id, roomsAdded: true, staffCreated: true, otaConnected: true, firstBooking: true, credentialsSent: true },
  ]});

  // ── Platform audit trail samples
  await db.platformAuditLog.createMany({ data: [
    { actorName: "system", action: "DAILY_JOBS", entity: "platform",
      details: "Renewal sweep, reminders and usage snapshot completed.", createdAt: day(-1, 3) },
    { actorName: "owner@velurex.in", action: "ANNOUNCEMENT_SENT", entity: "announcement", entityId: ann.id,
      details: `Sent "${ann.title}" to all tenants`, createdAt: day(-2, 11) },
    { actorName: "owner@velurex.in", action: "PLAN_CHANGE", entity: "subscription", entityId: subRoyal.id,
      propertyId: royalGrand.id, details: "Basic → Pro (yearly, prorated invoice generated)", createdAt: day(-320) },
  ]});
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
