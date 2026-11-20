import { createRoot } from "react-dom/client";
import Home from "../app/page";
import Account from "../app/account/page";
import { appPath } from "../lib/site-urls";
import "../app/globals.css";

const isAccount = location.pathname.replace(/\/$/, "") === appPath("/account");
createRoot(document.getElementById("root")!).render(isAccount ? <Account /> : <Home />);
