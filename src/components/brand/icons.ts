import { createLucideIcon, type IconNode } from 'lucide-react';

// 기존 아이콘의 size, strokeWidth, ref 및 SVG 접근성 속성을 그대로 지원한다.
export * from 'lucide-react';

const gold = 'var(--donaido-icon-gold, #f0aa26)';
type Shape = IconNode[number];

function outline(d: string): Shape {
  return ['path', { d }];
}

function accent(d: string): Shape {
  return ['path', { d, fill: gold, stroke: 'none' }];
}

function frame(x: number, y: number, width: number, height: number, rx = 2, highlighted = false): Shape {
  return ['rect', { x: `${x}`, y: `${y}`, width: `${width}`, height: `${height}`, rx: `${rx}`, ...(highlighted ? { fill: gold, stroke: 'none' } : {}) }];
}

function dot(x: number, y: number, radius = 1.4, highlighted = true): Shape {
  return ['circle', { cx: `${x}`, cy: `${y}`, r: `${radius}`, ...(highlighted ? { fill: gold, stroke: 'none' } : {}) }];
}

function icon(name: string, ...shapes: Shape[]) {
  return createLucideIcon(`Donaido${name}`, shapes.map(([tag, props], index) => [tag, { ...props, key: `${index}` }]));
}

export const House = icon('House', accent('M9 20v-4a3 3 0 0 1 6 0v4Z'), outline('M4.5 10.5 11 4a1.4 1.4 0 0 1 2 0l6.5 6.5a1 1 0 0 1-.7 1.7H18V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19v-6.8h-.8a1 1 0 0 1-.7-1.7Z M9 20v-4a3 3 0 0 1 6 0v4'));
export const Home = House;
export const LayoutDashboard = icon('LayoutDashboard', frame(3, 4, 18, 16, 3), frame(6, 7, 5, 4, 1, true), frame(13, 7, 5, 4, 1), frame(6, 13, 5, 4, 1), frame(13, 13, 5, 4, 1));
export const LayoutGrid = LayoutDashboard;
export const Store = icon('Store', accent('M5 4h3l-2 5c-.6 1-2.2 1-3-.2Zm5 0h3v5a2 2 0 0 1-4 0Zm5 0h3l2.5 4.8c-.7 1.3-2.5 1.3-3.3.2Z'), outline('M4.5 11v7.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V11 M10 20v-4a2 2 0 0 1 4 0v4 M3 8.3 5 4h14l2 4.3V9a2.5 2.5 0 0 1-4.5 1.5 2.6 2.6 0 0 1-4.5 0 2.6 2.6 0 0 1-4.5 0A2.5 2.5 0 0 1 3 9Z'));
export const Package = icon('Package', accent('m10 4-1 5v3h6V9l-1-5Z'), outline('M3 9l3.3-4.4A1.5 1.5 0 0 1 7.5 4h9a1.5 1.5 0 0 1 1.2.6L21 9v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19Z M3 9h18 M10 4 9 9v3h6V9l-1-5'));
export const ShoppingBag = icon('ShoppingBag', frame(7, 12, 4, 5, 1, true), outline('M5 8h14l1 11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z M9 10V6a3 3 0 0 1 6 0v4'));
export const Truck = icon('Truck', frame(5.5, 8, 5, 4.5, 1, true), outline('M3 16V7a2 2 0 0 1 2-2h9v11 M14 8h3.5l3.5 4v4h-2 M3 16h2m4 0h6'), dot(7, 17, 2, false), dot(17, 17, 2, false));
export const Video = icon('Video', frame(3, 5.5, 13, 13, 3), outline('m16 10 4-2.5a.6.6 0 0 1 1 .5v8a.6.6 0 0 1-1 .5L16 14'), accent('M8 9.5 12.4 12 8 14.5Z'));
export const MonitorPlay = icon('MonitorPlay', frame(3, 4.5, 18, 12, 2.5), outline('M9 20h6m-3-3.5V20'), accent('M10 7.5 15 10.5 10 13.5Z'));
export const Clapperboard = icon('Clapperboard', outline('M4 10h16v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z M4 10l-.7-3a1.5 1.5 0 0 1 1.1-1.8l13-3.1a1.5 1.5 0 0 1 1.8 1.1l.7 2.8L4 10Z M7 4.7l3 3.1m3-4.5 3 3.1'), accent('M10 12.3 15 15l-5 2.7Z'));
export const Radio = icon('Radio', dot(12, 12, 2.2), outline('M7.5 7.5a6.4 6.4 0 0 0 0 9m9-9a6.4 6.4 0 0 1 0 9M4.5 4.5a10.6 10.6 0 0 0 0 15m15-15a10.6 10.6 0 0 1 0 15'));
export const PlayCircle = icon('PlayCircle', dot(12, 12, 8.5, false), accent('M10 8 16 12l-6 4Z'));
export const CalendarDays = icon('CalendarDays', frame(3.5, 5, 17, 15.5, 2.5), outline('M7.5 3.5v3m9-3v3M3.5 9.5h17'), frame(7, 12, 2, 2, .5, true), frame(11, 12, 2, 2, .5, true), frame(15, 12, 2, 2, .5, true), frame(7, 16, 2, 2, .5, true), frame(11, 16, 2, 2, .5, true));
export const ReceiptText = icon('ReceiptText', outline('M13 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v6 M7 8h8m-8 4h6m-6 4h4'), dot(17.5, 17.5, 3.6), ['path', { d: 'm16 17.5 1 1 2-2', stroke: '#231d2c', strokeWidth: '1.3' }]);
export const FileText = icon('FileText', accent('M14 4v5h5Z'), outline('M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9l-5-5Zm0 0v5h5 M8 12h7m-7 4h7'));
export const Wallet = icon('Wallet', dot(12, 7, 3.6), outline('M8.5 7a3.5 3.5 0 1 1 7 0 M20 15.5v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v3 M4 10.5h16'), frame(14, 12.5, 7, 4, 1.5), dot(16.3, 14.5, .95));
export const WalletCards = Wallet;
export const CreditCard = icon('CreditCard', frame(3, 5, 18, 14, 2.5), outline('M3 10h18 M7 15h3'), frame(14, 13.5, 4, 2.5, .6, true));
export const Users = icon('Users', dot(9.5, 8, 3, false), dot(17.8, 8.8, 2.3, false), outline('M3 19v-1.5a6.5 6.5 0 0 1 13 0V19H3Zm14.7-6a4.4 4.4 0 0 1 4.1 4.4V19H19'));
export const UsersRound = Users;
export const UserRound = icon('UserRound', dot(12, 8, 3.5, false), outline('M5 19.5v-.9a7 7 0 1 1 14 0v.9Z'), dot(17.8, 7, 1.1));
export const CircleUserRound = icon('CircleUserRound', dot(12, 12, 9, false), dot(12, 9, 2.6, false), outline('M6.5 18.5a5.5 5.5 0 0 1 11 0'), dot(18.5, 5.5, 1.4));
export const Bell = icon('Bell', outline('M14.5 4.7A5.4 5.4 0 0 0 6.5 9v2.3c0 1.7-.7 2.7-2.1 4.1a1.1 1.1 0 0 0 .8 1.9h13.6a1.1 1.1 0 0 0 .8-1.9c-1.4-1.4-2.1-2.4-2.1-4.1v-1 M9.5 18a2.5 2.5 0 0 0 5 0'), dot(18.5, 5.5, 2.3));
export const BellRing = icon('BellRing', outline('M4 8a6 6 0 0 1 2-4m14 4a6 6 0 0 0-2-4 M12 4a5 5 0 0 0-5 5v3c0 2-1 3-2 4v1h14v-1c-1-1-2-2-2-4V9a5 5 0 0 0-5-5Z'), dot(12, 19.5, 1.5));
export const MessageSquare = icon('MessageSquare', outline('M20.5 10.5a6 6 0 0 1-6 6H10L5 20v-4.6a5.9 5.9 0 0 1-2-4.4v-.5a6 6 0 0 1 6-6h5.5a6 6 0 0 1 6 6Z'), dot(9.5, 10.5), dot(14, 10.5));
export const MessageSquareText = icon('MessageSquareText', outline('M20.5 10.5a6 6 0 0 1-6 6H10L5 20v-4.6a5.9 5.9 0 0 1-2-4.4v-.5a6 6 0 0 1 6-6h5.5a6 6 0 0 1 6 6Z'), frame(7, 8.5, 9, 1.7, .8, true), frame(7, 12, 6, 1.7, .8, true));
export const MessageCircleQuestion = icon('MessageCircleQuestion', outline('M21 11.4a8.6 8.6 0 0 1-8.6 8.6 8.8 8.8 0 0 1-4-.9L4 20l.9-4a8.6 8.6 0 1 1 16.1-4.6Z M10 9.3a2.2 2.2 0 1 1 3.2 2c-.7.4-1.2.9-1.2 1.6'), dot(12, 15.5, 1));
export const BarChart3 = icon('BarChart3', frame(4, 14, 4, 6.5, 1.4), frame(10, 10, 4, 10.5, 1.4), frame(16, 4, 4, 16.5, 1.4, true), frame(16, 4, 4, 16.5, 1.4));
export const Heart = icon('Heart', outline('M12 20.5 4.7 13a5 5 0 0 1 7.3-6.8 5 5 0 0 1 7.3 6.8Z'), accent('M12 16.8 8.5 13a2.3 2.3 0 0 1 3.5-3 2.3 2.3 0 0 1 3.5 3Z'));
export const HeartHandshake = icon('HeartHandshake', accent('M12 11 9 8a1.9 1.9 0 0 1 3-2.2A1.9 1.9 0 0 1 15 8Z'), outline('m3 13 3-2 4 2h4a1.5 1.5 0 0 1 0 3h-3m4.5-.8 3-2a1.6 1.6 0 0 1 2 2.4l-4.2 4a2 2 0 0 1-1.5.4l-7.7-1.5L3 19Z'));
export const PanelsTopLeft = icon('PanelsTopLeft', frame(3, 4, 18, 16, 2.5), outline('M3 9h18m-14 0v11'), frame(10, 12, 7, 4, 1.2, true));
export const BookOpen = icon('BookOpen', accent('M4 6h3c3 0 4 1 4 2v9c-1-1-3-1.3-7-1.3Z'), outline('M3.5 5.5h3.2c2.3 0 4.3.8 5.3 2 1-1.2 3-2 5.3-2h3.2V18h-3c-2.3 0-4.3.7-5.5 1.8C10.8 18.7 8.8 18 6.5 18h-3Z M12 7.5v12'));
export const BookOpenText = BookOpen;
export const Smartphone = icon('Smartphone', frame(6.5, 3, 11, 18, 2.6), frame(9, 7, 6, 6, 1.3, true), dot(12, 18, .9));
export const Gamepad2 = icon('Gamepad2', outline('M8 8h8c2.6 0 4 1.7 4.7 4.2l.7 2.9c.4 2-1.6 3.4-3.1 2.1L16 15H8l-2.3 2.2c-1.5 1.3-3.5-.1-3.1-2.1l.7-2.9C4 9.7 5.4 8 8 8Zm-1 2.5v4m-2-2h4'), dot(15, 12.5, 1), dot(18, 11, 1));
export const Gauge = icon('Gauge', outline('M5.1 18a9 9 0 1 1 13.8 0Z M12 13l4-4 M7 12h1'), dot(12, 13, 1.75));
export const CircleHelp = icon('CircleHelp', dot(12, 12, 9, false), outline('M9.5 9a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.1.9-1.1 1.7'), dot(12, 16.5, 1.3));
export const HelpCircle = CircleHelp;
export const Map = icon('Map', accent('m3.5 7.5 5-2v11l-5 2Z'), outline('m3.5 7.5 5-2 7 2 5-2v11l-5 2-7-2-5 2Zm5-2v11m7-9v11'));
export const Settings = icon('Settings', outline('m10 3-.6 2.3-1.5.9-2.3-.7L4 8.4l1.7 1.7v1.8L4 13.6l1.6 2.9 2.3-.7 1.5.9.6 2.3h4l.6-2.3 1.5-.9 2.3.7 1.6-2.9-1.7-1.7v-1.8L20 8.4l-1.6-2.9-2.3.7-1.5-.9L14 3Z'), dot(12, 11, 3.15));
export const ShieldCheck = icon('ShieldCheck', outline('M12 3c2.1 1.5 4.5 2.6 7 3v5.5c0 4.5-3 7.3-7 9.5-4-2.2-7-5-7-9.5V6a18 18 0 0 0 7-3Z'), accent('m8.1 11.6 2.7 3 5.4-5.4-1.3-1.3-4.1 4.1-1.4-1.6Z'));
export const ListChecks = icon('ListChecks', outline('M10 6h10m-10 6h10m-10 6h10'), accent('m3 6 1.3-1.2 1 1 2.2-2.1 1.2 1.2-3.4 3.4Zm0 6 1.3-1.2 1 1 2.2-2.1 1.2 1.2-3.4 3.4Zm0 6 1.3-1.2 1 1 2.2-2.1 1.2 1.2-3.4 3.4Z'));
