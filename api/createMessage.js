import db from "./data-source.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ message: "Método não permitido" });
  }

  const newData = req.body;

  const { data, error } = await db
    .from("messages")
    .insert([
      {
        name: newData.name,
        content: newData.content,
      },
    ])
    .select();

  if (error) {
    return res
      .status(500)
      .json({ error: "Erro ao criar recado: " + error.message });
  }

  return res.status(200).json(data);
}
