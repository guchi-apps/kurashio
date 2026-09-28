import { createClient } from "@supabase/supabase-js";

export const supabaseConfig = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "placeholder-key",
};

export const supabase = createClient(supabaseConfig.url, supabaseConfig.publishableKey);
