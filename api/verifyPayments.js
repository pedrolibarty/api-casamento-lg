import { ImapFlow } from "imapflow";
import dotenv from "dotenv";
import db from "./data-source.js";

dotenv.config();

const getPaymentsEmail = async () => {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.PIX_EMAIL,
      pass: process.env.PIX_PASSWORD,
    },
  });

  await client.connect();

  let emails = [];
  let lock = await client.getMailboxLock("INBOX");

  const uidsToMarkAsSeen = [];

  try {
    for await (let msg of client.fetch(
      { from: "no-reply@picpay.com", seen: false },
      { envelope: true, source: true }
    )) {
      const assunto = msg.envelope.subject || "";

      if (assunto.trim() === "Pagamento recebido via Pix") {
        const raw = msg.source.toString();

        const bodyMatch = raw.match(
          /Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)\r\n--/i
        );
        const body = bodyMatch
          ? bodyMatch[1].trim()
          : "(Não foi possível extrair texto)";

        emails.push({
          assunto,
          de: msg.envelope.from[0].address,
          corpo: body,
        });

        uidsToMarkAsSeen.push(msg.uid);
      }
    }

    if (uidsToMarkAsSeen.length > 0) {
      await client.messageFlagsAdd(uidsToMarkAsSeen, ["\\Seen"]);
    }
  } finally {
    lock.release();
  }

  await client.logout();

  const newPayments = [];

  for (let i = 0; i < emails.length; i++) {
    const content = emails[i].corpo;

    const iniName = "Pix=20de=0A";
    const endName = "=0AValor=20";

    const posIniName = content.indexOf(iniName);
    if (posIniName === -1) continue;

    const posEndName = content.indexOf(endName, posIniName + iniName.length);
    if (posEndName === -1) continue;

    let namePix = content
      .substring(posIniName + iniName.length, posEndName)
      .trim();

    namePix = namePix.replace(/=20/g, " ");

    namePix = namePix
      .toLowerCase()
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    const iniValue = "0AR$=20";

    const posIniValue = content.indexOf(iniValue);
    if (posIniValue === -1) continue;

    const valueSubstr = content.substring(posIniValue + iniValue.length);
    const posVirgula = valueSubstr.indexOf(",");
    if (posVirgula === -1) continue;

    let valuePix = valueSubstr.substring(0, posVirgula + 3);

    valuePix = Number(valuePix.replace(",", "."));

    newPayments.push({
      namePix: namePix,
      value: valuePix,
      status: "P",
    });
  }

  const { data, error } =
    newPayments.length > 0
      ? await db
          .from("payments_pix")
          .upsert(newPayments)
          .select("*")
          .eq("status", "P")
      : await db.from("payments_pix").select("*").eq("status", "P");

  if (error) {
    console.log(error);
    return "Erro";
  }

  return data;
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method !== "GET") {
    return res.status(405).json({ message: "Método não permitido" });
  }

  const paymentsPix = await getPaymentsEmail();
  if (paymentsPix === "Erro") {
    return res
      .status(500)
      .json({ error: "Erro ao registrar/obter pagamentos_pix" });
  }

  const { data: dataPayments, error: errorPayment } = await db
    .from("payments")
    .select("*")
    .eq("status_payment", "P");

  if (errorPayment) {
    return res.status(500).json({ error: errorPayment.message });
  }

  const matched = dataPayments
    .map((payment) => {
      const paymentSum = Number(
        (payment.value + payment.ind_payment).toFixed(2)
      );
      const pix = paymentsPix.find(
        (p) => Number(p.value.toFixed(2)) === paymentSum
      );
      if (pix) {
        return { paymentId: payment.id, pixId: pix.id };
      }
      return null;
    })
    .filter(Boolean);

  if (matched.length > 0) {
    const idsPayments = matched.map((m) => m.paymentId);
    await db
      .from("payments")
      .update({ status_payment: "F" })
      .in("id", idsPayments);

    for (const m of matched) {
      await db
        .from("payments_pix")
        .update({ status: "F", id_payment: m.paymentId })
        .eq("id", m.pixId);
    }
  }

  return res.status(200).json(matched);
}
