import db from "./data-source.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method !== "GET") {
    return res.status(405).json({ message: "Método não permitido" });
  }

  const { data, error } = await db.from("csm_pay_gifts").select("*");

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json(data);
}
