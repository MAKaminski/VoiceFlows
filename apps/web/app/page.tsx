import { redirect } from "next/navigation";

export default function Home() {
  redirect("/studio"); // the product, not the dev playground — nobody should need to know a URL
}
