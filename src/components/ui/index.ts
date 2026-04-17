// Barrel export for all UI primitives.
// Module code imports from "@/components/ui" — never from individual files.

export { Button, buttonVariants } from "./button";
export type { ButtonProps } from "./button";
export { Input } from "./input";
export type { InputProps } from "./input";
export { Label } from "./label";
export { Textarea } from "./textarea";
export type { TextareaProps } from "./textarea";
export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";
export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./sheet";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
export { Badge, badgeVariants } from "./badge";
export type { BadgeProps } from "./badge";
export { Separator } from "./separator";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";
export {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";
export { FormField } from "./FormField";
