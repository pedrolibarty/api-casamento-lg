import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const db = createClient(process.env.BASE_URL, process.env.BASE_KEY);

export default db;
