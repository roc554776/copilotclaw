import { BrowserRouter, Route, Routes } from "react-router-dom";
import { DashboardPage } from "./pages/DashboardPage";
import { SessionEventsPage } from "./pages/SessionEventsPage";
import { SessionsListPage } from "./pages/SessionsListPage";
import { StatusPage } from "./pages/StatusPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/sessions" element={<SessionsListPage />} />
        <Route path="/sessions/:sessionId/events" element={<SessionEventsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
