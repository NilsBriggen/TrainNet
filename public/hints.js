// HRDF attribute codes on trips (trips.txt "hints"): English texts from the official HRDF ATTRIBUT file,
// trimmed to what a passenger cares about. BZ and RZ aren't in that file; they're SBB's zone codes.
export const HINTS = {
  WR: "Restaurant", WS: "Bistro", MP: "Minibar / snack", SN: "Catering zone / vending machine", SC: "Service at seat in 1st class",
  FA: "Family coach with play area", FZ: "Family zone", BZ: "Business zone", RZ: "Quiet zone", FS: "Free Wi-Fi (SBB FreeSurf)",
  NF: "Low-floor access", HL: "Lift on board", PA: "Panorama coach", AW: "Open panoramic cars", PR: "Panorama coach: reservation compulsory",
  R: "Seat reservation possible", RE: "Reservation recommended", RR: "Reservation required", "2": "2nd class only", P: "Premium class",
  VR: "Bikes: reservation required", VB: "Bikes: limited places", VN: "No bikes", FL: "Splits on the way: check the coach signs",
  Z: "Surcharge", DS: "Steamer", B: "Bar", FW: "Photo compartment with lowerable windows",
};
