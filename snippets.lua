local util = require("jit.util")
local function to_console_string(value)
	local kind = type(value)
	local str
	if kind == "string" then
		if string.find(value, "%c") then
			str = string.format("%q", value)
		else
			str = value
		end
	elseif kind == "table" then
		local mt = getmetatable(value)
		local class = rawget(value, "___is_class_metatable___") and "class"
			or (mt and mt ~= true and mt.___is_class_metatable___ and table.find(_G, mt) or "table")
		str = string.format("[%s: %p]", class, value)
	elseif kind == "function" then
		local info = util.funcinfo(value)
		local is_file_func = (info.source and not string.find(info.source, "\n"))
		local where = is_file_func and string.format("%s:%s", info.source, info.linedefined) or (info.addr and string.format("0x%012x", info.addr)) or "<unknown>"
		str = string.format("<%s at %s>", value, where)
	elseif kind == "userdata" then
		str = string.format("{%s: %p}", Script.type_name(value), value)
	else
		str = string.format("%s", value)
	end
	return str
end
rawset(_G, "to_console_string", to_console_string)

local function resolve_path(value, path)
	for i=1, #path do
		local part = path[i]
		if part == -1 then -- Special pseudo-path.
			value = getmetatable(value)
			goto continue
		elseif type(value) == "table" then
			for _, v in pairs(value) do
				if part == 0 then
					value = v
					goto continue
				end
				part = part - 1
			end
		end
		do return nil end
		::continue::
	end
	return value
end

local ffi = require("ffi")
local function table_size(t)
	local addr = string.match(string.format("%p", t), "0x(%x+)")
	assert(addr, "invalid pointer")
	local ptr = ffi.cast("uint32_t*", tonumber(addr, 16))
	return ptr[6], ptr[7]
end

local function format_value(value, name, include_extra_data)
	local kind = type(value)
	local children
	local metatable
	if include_extra_data and kind == "table" then
		children = {}
		for k, v in pairs(value) do
			children[#children+1] = format_value(v, k)
		end

		local mt = getmetatable(value)
		if mt ~= nil then
			children[#children+1] = format_value(mt, '(metatable)', false)
		end

		local asize, hsize = table_size(value)
		children[#children+1] = format_value(asize, '(size array)', false)
		children[#children+1] = format_value(hsize, '(size hash)', false)
	end
	return {
		name = to_console_string(name),
		value = to_console_string(value),
		type = kind,
		children = children, metatable = metatable,
	}
end

local function ctlsub(c)
	if c == "\n" then return "\\n"
	elseif c == "\r" then return "\\r"
	elseif c == "\t" then return "\\t"
	else return string.format("\\%03d", string.byte(c))
	end
end

local sub, gsub, format = string.sub, string.gsub, string.format
local band, shr = bit.band, bit.rshift
local bcnames = "ISLT  ISGE  ISLE  ISGT  ISEQV ISNEV ISEQS ISNES ISEQN ISNEN ISEQP ISNEP ISTC  ISFC  IST   ISF   ISTYPEISNUM MOV   NOT   UNM   LEN   ADDVN SUBVN MULVN DIVVN MODVN ADDNV SUBNV MULNV DIVNV MODNV ADDVV SUBVV MULVV DIVVV MODVV POW   CAT   KSTR  KCDATAKSHORTKNUM  KPRI  KNIL  UGET  USETV USETS USETN USETP UCLO  FNEW  TNEW  TDUP  GGET  GSET  TGETV TGETS TGETB TGETR TSETV TSETS TSETB TSETM TSETR CALLM CALL  CALLMTCALLT ITERC ITERN VARG  ISNEXTRETM  RET   RET0  RET1  FORI  JFORI FORL  IFORL JFORL ITERL IITERLJITERLLOOP  ILOOP JLOOP JMP   FUNCF IFUNCFJFUNCFFUNCV IFUNCVJFUNCVFUNCC FUNCCW"
local function bcline(func, pc, ins, m)
	if not ins then return end
	local ma, mb, mc = band(m, 7), band(m, 15*8), band(m, 15*128)
	local a = band(shr(ins, 8), 0xff)
	local oidx = 6*band(ins, 0xff)
	local op = sub(bcnames, oidx+1, oidx+6)
	local s = format("%-6s %3s ",op, ma == 0 and "" or a)
	local d = shr(ins, 16)
	if mc == 13*128 then -- BCMjump
		return format("%s=> %04d\n", s, pc+d-0x7fff)
	end
	if mb ~= 0 then
		d = band(d, 0xff)
	elseif mc == 0 then
		return s.."\n"
	end
	local kc
	if mc == 10*128 then -- BCMstr
		kc = util.funck(func, -d-1)
		kc = format(#kc > 40 and '"%.40s"~' or '"%s"', gsub(kc, "%c", ctlsub))
	elseif mc == 9*128 then -- BCMnum
		kc = util.funck(func, d)
		if op == "TSETM " then kc = kc - 2^52 end
	elseif mc == 12*128 then -- BCMfunc
		local fi = util.funcinfo(util.funck(func, -d-1))
		if fi.ffid then
			kc = vmdef.ffnames[fi.ffid]
		else
			kc = fi.loc
		end
	elseif mc == 5*128 then -- BCMuv
		kc = util.funcuvname(func, d)
	end
	if ma == 5 then -- BCMuv
		local ka = util.funcuvname(func, a)
		if kc then kc = ka.." ; "..kc else kc = ka end
	end
	if mb ~= 0 then
		local b = shr(ins, 24)
		if kc then return format("%s%3d %3d  ; %s\n", s, b, d, kc) end
		return format("%s%3d %3d\n", s, b, d)
	end
	if kc then return format("%s%3d      ; %s\n", s, d, kc) end
	if mc == 7*128 and d > 32767 then d = d - 65536 end -- BCMlits
	return format("%s%3d\n", s, d)
end

local function make_environment(level)
	level = level + 1
	return setmetatable({}, {
		__index = function(_, target_name)
			local found, target_value = false
			for i=1, 9999 do -- (1) Locals.
				local name, value = debug.getlocal(level, i)
				if not name then break end
				-- Need to keep the last match in case there is name shadowing.
				if name == target_name then
					found = true
					target_value = value
				end
			end
			if found then
				return target_value
			end
			local func = debug.getinfo(level, "f").func
			for i=1, 9999 do -- (2) Upvalues.
				local name, value = debug.getupvalue(func, i)
				if not name then break end
				if name == target_name then
					return value
				end
			end
			return rawget(_G, target_name) -- (3) Globals.
		end,
		__newindex = function(_, target_name, target_value)
			local found, target_i = false
			for i=1, 9999 do -- (1) Locals.
				local name = debug.getlocal(level, i)
				if not name then break end
				-- Need to keep the last match in case there is name shadowing.
				if name == target_name then
					found = true
					target_i = i
				end
			end
			if found then
				debug.setlocal(level, target_i, target_value)
			end
			local func = debug.getinfo(level, "f").func
			for i=1, 9999 do -- (2) Upvalues.
				local name, value = debug.getupvalue(func, i)
				if not name then break end
				if name == target_name then
					debug.setupvalue(func, i, target_value)
					return
				end
			end
			rawset(_G, target_name, target_value) -- (3) Globals.
		end,
	})
end

local EVAL_REGISTRY = {}

local handlers = {
	stack = function(request)
		local response = {}
		for i=1, 9999 do
			local info = debug.getinfo(1+i, "nSl")
			if not info then break end
			response[i] = info
		end
		return response
	end,
	locals = function(request)
		local response = {}
		local level = request.level
		for i=1, 1000000000 do
			local name, value = debug.getlocal(level, i)
			if not name then break end
			response[i] = format_value(value, name)
		end
		return response
	end,
	upvals = function(request)
		local func = debug.getinfo(request.level, "f").func
		local response = {}
		for i=1, 1000000000 do
			local name, value = debug.getupvalue(func, i)
			if not name then break end
			response[i] = format_value(value, name)
		end
		return response
	end,
	contents = function(request)
		local _, value
		local id = request.id
		if id > 0 then
			_, value = debug.getlocal(request.level, id)
		else
			_, value = debug.getupvalue(request.level, -id)
		end
		return format_value(resolve_path(value, request.path))
	end,
	eval = function(request)
		-- If a stack level is provided, we have to adjust it skipping all the
		-- debug stuff that is currently on the stack. This is *very* brittle.
		local id = #EVAL_REGISTRY+1
		local eval_name = string.format("eval#%d", id)
		local thunk = loadstring("return ("..request.expression..")", eval_name)
		if not thunk then
			thunk = assert(loadstring(request.expression, eval_name))
		end
		local environment = request.level and make_environment(request.level + (3+2)) or _G
		setfenv(thunk, environment)
		local result = thunk()
		local response = format_value(result, eval_name, not not request.completion)
		if not request.completion then
			EVAL_REGISTRY[id] = result
			response.id = id
		end
		return response
	end,
	expandEval = function(request)
		return format_value(resolve_path(EVAL_REGISTRY[request.id], request.path), nil, true)
	end,
	disassemble = function(request)
		local info = debug.getinfo(request.level+4, "fS")
		local func = info.func
		local bc = {}
		for pc=1, 1000000000 do
			local ins, m = util.funcbc(func, pc)
			if not ins then break end
			bc[pc] = {
				bytes = bit.tohex(ins),
				ins = bcline(func, pc, ins, m),
				line = util.funcinfo(func, pc).currentline,
			}
		end
		return {
			bc = bc,
			source = info.source or "<unknown>",
		}
	end,
}

function VSCodeDebugAdapter(str)
	local request = cjson.decode(str)
	local ok, result = pcall(handlers[request.request_type], request)
	Application.console_send({
		type = "vscode_debug_adapter",
		request_id = request.request_id,
		request_type = request.request_type,
		result = result,
		ok = ok,
	})
end