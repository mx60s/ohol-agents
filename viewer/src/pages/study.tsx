// The study page (study.html): one section per proposal question. Charts: ../study/.
import { setClient } from "../data/client.ts";
import { installSyntheticIfRequested } from "../study/syntheticClient.ts";
import { StudyPage } from "../study/StudyPage.tsx";
import { mount } from "./mount.tsx";

if (typeof window !== "undefined") installSyntheticIfRequested(window.location.search, setClient);

mount(<StudyPage />);
