import { ImapFlow } from "imapflow";
import dotenv from "dotenv";
import db from "./data-source.js";
import { simpleParser } from "mailparser";
import { htmlToText } from "html-to-text";

dotenv.config();

const streamToString = async (stream) => {
  const chunks = [];
  for await (let chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

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
      { from: "todomundo@nubank.com.br" , seen: false},
      { envelope: true, bodyStructure: true, source: true }
    )) {
      const assunto = msg.envelope.subject || "";

      if (/você recebeu uma transferência/i.test(assunto)) {
        let body = "(Não foi possível extrair texto)";

        try {
          let part = null;
          let isHtml = false;

          if (msg.bodyStructure.type === "text") {
            part = msg.bodyStructure;
            isHtml = msg.bodyStructure.subtype === "html";
          } else if (msg.bodyStructure.childNodes) {
            const findPart = (node, type, subtype) => {
              if (node.type === type && node.subtype === subtype) return node;
              if (node.childNodes) {
                for (const child of node.childNodes) {
                  const found = findPart(child, type, subtype);
                  if (found) return found;
                }
              }
              return null;
            };

            part = findPart(msg.bodyStructure, "text", "plain");
            if (!part) {
              part = findPart(msg.bodyStructure, "text", "html");
              isHtml = true;
            }
          }

          if (part) {
            const { content } = await client.download(msg.uid, part.part);
            let raw = (await streamToString(content)).trim();
            body = isHtml ? htmlToText(raw, { wordwrap: false }) : raw;
          } else if (msg.source) {
            const parsed = await simpleParser(msg.source);
            if (parsed.text) {
              body = parsed.text.trim();
            } else if (parsed.html) {
              body = htmlToText(parsed.html, { wordwrap: false }).trim();
            }
          }
        } catch (err) {
          console.log("\x1b[32m%s\x1b[0m", err);
        }

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

    const iniName = "recebeu um Pix de ";
    const iniName2 = "transferência de ";
    const endName = " e o valor";
    let marker = iniName;

    let posIniName = content.indexOf(iniName);
    if (posIniName === -1) {
      posIniName = content.indexOf(iniName2);
      if (posIniName === -1) continue;
      marker = iniName2;
    }

    const posEndName = content.indexOf(endName, posIniName + iniName.length);
    if (posEndName === -1) continue;

    let namePix = content
      .substring(posIniName + marker.length, posEndName)
      .trim();

    namePix = namePix
      .toLowerCase()
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

    const iniValue = "R$ ";

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

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

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
