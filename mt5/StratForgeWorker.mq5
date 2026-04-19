#property strict
#include <Trade/Trade.mqh>

input string ApiBaseUrl  = "http://127.0.0.1:9000";
input string ApiKey      = "change-me";
input string UserId      = "rose";
input int    PollSeconds = 5;

CTrade trade;

string JsonEscape(string s){ StringReplace(s,"\\","\\\\"); StringReplace(s,"\"","\\\""); StringReplace(s,"\r","\\r"); StringReplace(s,"\n","\\n"); return s; }

string ExtractJsonString(string json, string key)
{
   string pattern = "\"" + key + "\":";
   int pos = StringFind(json, pattern);
   if(pos < 0) return "";
   pos += StringLen(pattern);
   while(pos < StringLen(json) && (StringGetCharacter(json,pos)==' ' || StringGetCharacter(json,pos)=='\"')) pos++;
   int end = pos;
   while(end < StringLen(json) && StringGetCharacter(json,end)!='\"') end++;
   return StringSubstr(json,pos,end-pos);
}

double ExtractJsonNumber(string json, string key)
{
   string pattern = "\"" + key + "\":";
   int pos = StringFind(json, pattern);
   if(pos < 0) return 0.0;
   pos += StringLen(pattern);
   while(pos < StringLen(json) && StringGetCharacter(json,pos)==' ') pos++;
   int end = pos;
   while(end < StringLen(json)) {
      ushort ch = StringGetCharacter(json,end);
      if((ch>='0' && ch<='9') || ch=='.' || ch=='-') end++; else break;
   }
   return StringToDouble(StringSubstr(json,pos,end-pos));
}

bool HttpGet(string url, string &response, int &statusCode)
{
   char data[]; char result[]; string headers = "x-api-key: " + ApiKey + "\r\n"; string result_headers="";
   ArrayResize(data,0); ArrayResize(result,0);
   ResetLastError();
   int res = WebRequest("GET", url, headers, 5000, data, result, result_headers);
   if(res == -1){ Print("HttpGet failed ", GetLastError(), " url=", url); statusCode=-1; response=""; return false; }
   statusCode = res; response = CharArrayToString(result,0,-1,CP_UTF8); return true;
}

bool HttpPost(string url, string body, string &response, int &statusCode)
{
   char data[]; char result[]; string headers = "Content-Type: application/json\r\nx-api-key: " + ApiKey + "\r\n"; string result_headers="";
   StringToCharArray(body, data, 0, StringLen(body), CP_UTF8); ArrayResize(result,0);
   ResetLastError();
   int res = WebRequest("POST", url, headers, 5000, data, result, result_headers);
   if(res == -1){ Print("HttpPost failed ", GetLastError(), " url=", url); statusCode=-1; response=""; return false; }
   statusCode = res; response = CharArrayToString(result,0,-1,CP_UTF8); return true;
}

void PostEvent(string commandId, string type, string status, string payloadJson)
{
   string url = ApiBaseUrl + "/users/" + UserId + "/events";
   string body = "{" \
      "\"commandId\":\"" + JsonEscape(commandId) + "\"," \
      "\"type\":\"" + JsonEscape(type) + "\"," \
      "\"status\":\"" + JsonEscape(status) + "\"," \
      "\"payload\":" + payloadJson +
      "}";
   string response=""; int code=0; HttpPost(url, body, response, code);
   Print("PostEvent status=", code, " body=", response);
}

string PositionTypeName(long type){ return type==POSITION_TYPE_SELL ? "sell" : "buy"; }

double NormalizePrice(string symbol, double price)
{
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   return NormalizeDouble(price, digits);
}

double GetPoint(string symbol)
{
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point <= 0) point = 0.01;
   return point;
}

double GetMinStopDistance(string symbol)
{
   double point = GetPoint(symbol);
   int stopsLevel = (int)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
   int freezeLevel = (int)SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   double minDistance = MathMax(stopsLevel, freezeLevel) * point;
   double fallback = point * 300.0;
   if(StringFind(symbol, "XAU") >= 0 || StringFind(symbol, "GOLD") >= 0) fallback = MathMax(fallback, 3.0);
   if(StringFind(symbol, "Volatility") >= 0 || StringFind(symbol, "Crash") >= 0 || StringFind(symbol, "Boom") >= 0) fallback = MathMax(fallback, point * 500.0);
   return MathMax(minDistance, fallback);
}

bool PrepareStops(string symbol, string side, double requestedSl, double requestedTp, double &finalSl, double &finalTp, double &entryPrice, string &comment)
{
   MqlTick tick;
   if(!SymbolInfoTick(symbol, tick)) {
      comment = "tick unavailable";
      return false;
   }

   double minStop = GetMinStopDistance(symbol);
   entryPrice = (side == "sell") ? tick.bid : tick.ask;
   finalSl = requestedSl;
   finalTp = requestedTp;

   if(side == "buy")
   {
      if(finalSl <= 0 || finalSl >= entryPrice - minStop) finalSl = entryPrice - (minStop * 1.2);
      if(finalTp <= 0 || finalTp <= entryPrice + minStop) finalTp = entryPrice + MathMax((entryPrice - finalSl) * 2.0, minStop * 1.5);
   }
   else
   {
      if(finalSl <= 0 || finalSl <= entryPrice + minStop) finalSl = entryPrice + (minStop * 1.2);
      if(finalTp <= 0 || finalTp >= entryPrice - minStop) finalTp = entryPrice - MathMax((finalSl - entryPrice) * 2.0, minStop * 1.5);
   }

   finalSl = NormalizePrice(symbol, finalSl);
   finalTp = NormalizePrice(symbol, finalTp);
   entryPrice = NormalizePrice(symbol, entryPrice);

   if(side == "buy")
   {
      if(finalSl >= entryPrice || finalTp <= entryPrice) {
         comment = "invalid buy stop orientation";
         return false;
      }
      if((entryPrice - finalSl) < minStop || (finalTp - entryPrice) < minStop) {
         comment = "buy stops too close";
         return false;
      }
   }
   else
   {
      if(finalSl <= entryPrice || finalTp >= entryPrice) {
         comment = "invalid sell stop orientation";
         return false;
      }
      if((finalSl - entryPrice) < minStop || (entryPrice - finalTp) < minStop) {
         comment = "sell stops too close";
         return false;
      }
   }

   comment = StringFormat("entry %.2f minStop %.2f", entryPrice, minStop);
   return true;
}

void HandleAccountInfo(string commandId)
{
   string payload = StringFormat("{\"login\":\"%I64d\",\"server\":\"%s\",\"name\":\"%s\",\"balance\":%.2f,\"equity\":%.2f}",
      AccountInfoInteger(ACCOUNT_LOGIN), JsonEscape(AccountInfoString(ACCOUNT_SERVER)), JsonEscape(AccountInfoString(ACCOUNT_NAME)),
      AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY));
   PostEvent(commandId, "account_info", "done", payload);
}

void HandlePositions(string commandId)
{
   int total = PositionsTotal();
   string arr = "[";
   for(int i=0;i<total;i++){
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      if(StringLen(arr)>1) arr += ",";
      arr += StringFormat("{\"ticket\":%I64d,\"symbol\":\"%s\",\"type\":%d,\"side\":\"%s\",\"volume\":%.2f,\"price_open\":%.5f,\"sl\":%.5f,\"tp\":%.5f}",
         PositionGetInteger(POSITION_TICKET),
         JsonEscape(PositionGetString(POSITION_SYMBOL)),
         (int)PositionGetInteger(POSITION_TYPE),
         PositionTypeName(PositionGetInteger(POSITION_TYPE)),
         PositionGetDouble(POSITION_VOLUME),
         PositionGetDouble(POSITION_PRICE_OPEN),
         PositionGetDouble(POSITION_SL),
         PositionGetDouble(POSITION_TP));
   }
   arr += "]";
   string payload = "{\"count\":" + IntegerToString(total) + ",\"positions\":" + arr + "}";
   PostEvent(commandId, "positions", "done", payload);
}

void HandleSymbols(string commandId)
{
   int total = SymbolsTotal(true);
   string arr = "[";
   int limit = MathMin(total, 100);
   for(int i=0;i<limit;i++){
      string sym = SymbolName(i, true);
      if(StringLen(arr)>1) arr += ",";
      arr += "\"" + JsonEscape(sym) + "\"";
   }
   arr += "]";
   PostEvent(commandId, "symbols", "done", "{\"symbols\":" + arr + "}");
}

void HandlePlaceOrder(string commandId, string json)
{
   string symbol = ExtractJsonString(json, "symbol");
   string side = ExtractJsonString(json, "side");
   double volume = ExtractJsonNumber(json, "volume");
   double requestedSl = ExtractJsonNumber(json, "sl");
   double requestedTp = ExtractJsonNumber(json, "tp");
   string rationale = ExtractJsonString(json, "rationale");

   if(symbol=="" || volume<=0){ PostEvent(commandId, "place_order", "failed", "{\"error\":\"invalid payload\"}"); return; }
   if(!SymbolSelect(symbol,true)){ PostEvent(commandId, "place_order", "failed", "{\"error\":\"symbol select failed\"}"); return; }

   double sl=0, tp=0, entryPrice=0;
   string stopComment="";
   if(!PrepareStops(symbol, side, requestedSl, requestedTp, sl, tp, entryPrice, stopComment)) {
      string payload = StringFormat("{\"error\":\"invalid stops\",\"comment\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"requestedSl\":%.5f,\"requestedTp\":%.5f,\"entryPrice\":%.5f}",
         JsonEscape(stopComment), JsonEscape(symbol), JsonEscape(side), requestedSl, requestedTp, entryPrice);
      PostEvent(commandId, "place_order", "failed", payload);
      return;
   }

   bool ok = false;
   if(side=="buy") ok = trade.Buy(volume, symbol, 0.0, sl, tp, "StratForge");
   else if(side=="sell") ok = trade.Sell(volume, symbol, 0.0, sl, tp, "StratForge");
   else { PostEvent(commandId, "place_order", "failed", "{\"error\":\"invalid side\"}"); return; }

   if(ok){
      string payload = StringFormat("{\"retcode\":%d,\"order\":\"%I64d\",\"deal\":\"%I64d\",\"symbol\":\"%s\",\"side\":\"%s\",\"entryPrice\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"rationale\":\"%s\",\"comment\":\"%s\"}",
         (int)trade.ResultRetcode(), trade.ResultOrder(), trade.ResultDeal(), JsonEscape(symbol), JsonEscape(side), entryPrice, sl, tp, JsonEscape(rationale), JsonEscape(stopComment));
      PostEvent(commandId, "place_order", "done", payload);
   } else {
      string payload = StringFormat("{\"retcode\":%d,\"error\":\"order failed\",\"comment\":\"%s\",\"symbol\":\"%s\",\"side\":\"%s\",\"entryPrice\":%.5f,\"sl\":%.5f,\"tp\":%.5f}",
         (int)trade.ResultRetcode(), JsonEscape(trade.ResultComment()), JsonEscape(symbol), JsonEscape(side), entryPrice, sl, tp);
      PostEvent(commandId, "place_order", "failed", payload);
   }
}

void HandleModify(string commandId, string json)
{
   long ticket = (long)ExtractJsonNumber(json, "position_ticket");
   double requestedSl = ExtractJsonNumber(json, "sl");
   double requestedTp = ExtractJsonNumber(json, "tp");
   if(ticket<=0){ PostEvent(commandId, "modify_sl_tp", "failed", "{\"error\":\"missing ticket\"}"); return; }
   if(!PositionSelectByTicket(ticket)){ PostEvent(commandId, "modify_sl_tp", "failed", "{\"error\":\"position not found\"}"); return; }
   string sym = PositionGetString(POSITION_SYMBOL);
   string side = PositionTypeName(PositionGetInteger(POSITION_TYPE));
   double curSl = PositionGetDouble(POSITION_SL);
   double curTp = PositionGetDouble(POSITION_TP);
   double entryPrice=0, sl=curSl, tp=curTp; string comment="";
   if(!PrepareStops(sym, side, requestedSl>0?requestedSl:curSl, requestedTp>0?requestedTp:curTp, sl, tp, entryPrice, comment)) {
      string payload = StringFormat("{\"ticket\":%I64d,\"error\":\"invalid modify stops\",\"comment\":\"%s\"}", ticket, JsonEscape(comment));
      PostEvent(commandId, "modify_sl_tp", "failed", payload);
      return;
   }
   bool ok = trade.PositionModify(sym, sl, tp);
   if(ok) PostEvent(commandId, "modify_sl_tp", "done", StringFormat("{\"ticket\":%I64d,\"sl\":%.5f,\"tp\":%.5f,\"comment\":\"%s\"}", ticket, sl, tp, JsonEscape(comment)));
   else PostEvent(commandId, "modify_sl_tp", "failed", StringFormat("{\"ticket\":%I64d,\"retcode\":%d,\"error\":\"modify failed\",\"comment\":\"%s\"}", ticket, (int)trade.ResultRetcode(), JsonEscape(trade.ResultComment())));
}

void HandleClosePosition(string commandId, string json)
{
   long ticket = (long)ExtractJsonNumber(json, "ticket");
   double volume = ExtractJsonNumber(json, "volume");
   if(ticket<=0){ PostEvent(commandId, "close_position", "failed", "{\"error\":\"missing ticket\"}"); return; }
   if(!PositionSelectByTicket(ticket)){ PostEvent(commandId, "close_position", "failed", "{\"error\":\"position not found\"}"); return; }
   string sym = PositionGetString(POSITION_SYMBOL);
   double posVol = PositionGetDouble(POSITION_VOLUME);
   bool ok = false;
   if(volume > 0 && volume < posVol) ok = trade.PositionClosePartial(sym, volume);
   if(!ok) ok = trade.PositionClose(sym);
   if(ok) PostEvent(commandId, "close_position", "done", StringFormat("{\"ticket\":%I64d,\"symbol\":\"%s\"}", ticket, JsonEscape(sym)));
   else PostEvent(commandId, "close_position", "failed", StringFormat("{\"ticket\":%I64d,\"retcode\":%d,\"error\":\"close failed\",\"comment\":\"%s\"}", ticket, (int)trade.ResultRetcode(), JsonEscape(trade.ResultComment())));
}

void HandleFlatten(string commandId)
{
   int total = PositionsTotal();
   int closed = 0;
   for(int i=total-1;i>=0;i--){
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      if(trade.PositionClose(sym)) closed++;
   }
   PostEvent(commandId, "flatten", "done", "{\"closed\":" + IntegerToString(closed) + "}");
}

void PollQueue()
{
   string url = ApiBaseUrl + "/users/" + UserId + "/commands/next";
   string response=""; int statusCode=0;
   if(!HttpGet(url, response, statusCode)) return;
   if(statusCode != 200){ Print("PollQueue bad status=", statusCode, " body=", response); return; }
   if(StringFind(response, "\"command\":null") >= 0) return;

   string commandId = ExtractJsonString(response, "id");
   string type = ExtractJsonString(response, "type");
   Print("Queue response: ", response);
   if(commandId=="" || type=="") return;

   if(type=="account_info") HandleAccountInfo(commandId);
   else if(type=="positions") HandlePositions(commandId);
   else if(type=="symbols") HandleSymbols(commandId);
   else if(type=="place_order") HandlePlaceOrder(commandId, response);
   else if(type=="modify_sl_tp") HandleModify(commandId, response);
   else if(type=="close_position") HandleClosePosition(commandId, response);
   else if(type=="flatten") HandleFlatten(commandId);
   else PostEvent(commandId, type, "failed", "{\"error\":\"unknown command\"}");
}

int OnInit(){ Print("StratForgeWorker started user=", UserId); EventSetTimer(PollSeconds); return(INIT_SUCCEEDED); }
void OnDeinit(const int reason){ EventKillTimer(); }
void OnTimer(){ PollQueue(); }
