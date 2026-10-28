// Source headers only; every value below is synthetic.
export const headers = [
  "Date", "Time", "Food Name", "Serving Size", "Serving Qty", "Serving Weight (g)",
  "Calories (kcal)", "Fat (g)", "Carbs (g)", "Protein (g)", "Alcohol (g)",
  "B12, Cobalamin (mcg)", "B1, Thiamine (mg)", "B2, Riboflavin (mg)", "B3, Niacin (mg)",
  "B5, Pantothenic Acid (mg)", "B6, Pyridoxine (mg)", "Caffeine (mg)", "Calcium (mg)",
  "Cholesterol (mg)", "Choline (mg)", "Copper (mg)", "Cysteine (g)",
  "Monounsaturated Fat (g)", "Polyunsaturated Fat (g)", "Saturated Fat (g)", "Trans Fat (g)",
  "Fiber (g)", "Folate (mcg)", "Histidine (g)", "Iron (mg)", "Isoleucine (g)", "Leucine (g)",
  "Lysine (g)", "Magnesium (mg)", "Manganese (mg)", "Methionine (g)", "Omega-3 ALA (g)",
  "Omega-3 DHA (g)", "Omega-3 EPA (g)", "Omega-3 (g)", "Omega-6 (g)", "Phenylalanine (g)",
  "Phosphorus (mg)", "Potassium (mg)", "Selenium (mcg)", "Sodium (mg)", "Starch (g)",
  "Sugars (g)", "Sugars Added (g)", "Threonine (g)", "Tryptophan (g)", "Tyrosine (g)",
  "Valine (g)", "Vitamin A (mcg)", "Vitamin C (mg)", "Vitamin D (mcg)", "Vitamin E (mg)",
  "Vitamin K (mcg)", "Water (g)", "Zinc (mg)",
];

export const row = [
  "2020-01-02", "07:38 PM", 'Synthetic "meal", oats', "one,\nserving", 2, 125,
  240, 4, 30, 21, ...headers.slice(10).map((_, i) => i + 0.125),
];
export const nutrients = Object.fromEntries(headers.slice(10).map((key, i) => [key, i + 0.125]));
export const legacy = {
  date: "2020-01-02", time: "19:38", name: 'Synthetic "meal", oats', serving_size: "one,\nserving",
  serving_qty: 2, serving_weight_g: 125, calories: 240, fat: 4, carbs: 30, protein: 21,
};

export function csv(rows = [row], columns = headers) {
  return [columns, ...rows].map(cells => cells.map(value =>
    `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
}
