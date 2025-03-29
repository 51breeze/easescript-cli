
const esbuild = require('esbuild');
const loader = require('./loader');
const path = require('path');
const fs = require('fs-extra');
const {makeTyping} = require('./make');
const Compiler = require('easescript/lib/core/Compiler');
const { isClientSide,getPlugins, callAsyncSequence} = require('./helpers');

function hasClientPlugin(plugins){
    return plugins.some(plugin=>isClientSide(plugin));
}

async function builder(compile, escOptions, files){
    const plugins = compile.options.plugins
    const outdir = escOptions.output;
    await compile.initialize();

    const getEsBuildOptions=(file, output, bundleOptions)=>{
        const plugins =  (escOptions.plugins || []).slice(0);
        const esbuildOptions = bundleOptions.esbuildOptions;
        const _escOptions = esbuildOptions ? Object.assign({}, escOptions, esbuildOptions) : escOptions;
        plugins.unshift( loader(compile, bundleOptions.plugins || [], _escOptions) );

        const ext = path.extname(output);
        let outfile = output;
        let outdir = void 0;
        if(ext){
            let jsMap = {
                '.vue':'.js',
                '.es':'.js',
                '.ts':'.js',
                '.ease':'.js',
            }
            let suffix = _escOptions.loaders[ext] === 'css' ? '.css' : jsMap[ext];
            if(suffix){
                const info = path.parse(output);
                outfile = info.dir+'/'+ info.name + suffix;
            }
        }else{
            outfile = void 0;
            outdir = output;
        }

        return {
            entryPoints:[file],
            outfile,
            outdir,
            format: _escOptions.format || 'esm',
            platform: _escOptions.platform || 'node',
            metafile:true,
            bundle:true,
            loader:_escOptions.loaders,
            treeShaking:_escOptions.treeShaking,
            nodePaths:_escOptions.resolve.paths,
            minify:_escOptions.minify,
            sourcemap:!!_escOptions.sourcemap,
            resolveExtensions:_escOptions.resolve.extensions,
            define:_escOptions.define,
            external:_escOptions.externals || [],
            plugins,
        };
    }

    const assetsRecords = new Map();
    const buildAsset = async (asset, options={})=>{
        const input = compile.normalizePath(asset.file);
        if(!assetsRecords.has(input)){
            assetsRecords.set(input, [asset, options]);
            if(escOptions.watch && compile.fsWatcher){
                compile.fsWatcher.add(input);
            }
        }
        const outfile = asset.outfile;
        const buildOptions = getEsBuildOptions(input, outfile, options)
        const result = await esbuild.build(buildOptions);
        const outputs = result.metafile.outputs;
        Object.keys(outputs).forEach( dist=>{
            const item = outputs[dist];
            if(input.includes(item.entryPoint)){
                if(fs.existsSync(asset.outfile)){
                    fs.unlinkSync(asset.outfile);
                }
            }
        });
    }

    const buildAssets = async(plugin, assets)=>{
        const bundle = plugin.options.bundle;
        if(bundle.enable){
            assets = Array.from(assets).filter(asset=>bundle.extensions.includes('.'+asset.type));
            await Promise.allSettled(assets.map(asset=>{
                return buildAsset(asset, plugin.options.bundle);
            }));
        }
    }

    const pluginInstances = plugins.map(config=>{
        const options = config.options || (config.options={});
        options.emitFile=true;
        if(outdir)options.outDir = outdir;
        return getPlugins(config)
    });

    const compilationSets= new Set();
    await Promise.allSettled(files.map(async file=>{
        const compilation = await compile.createCompilation(file);
        if(compilation){
            compilation.createStack();
            compilationSets.add(compilation)
        }else{
            console.error(`Not resolved compilation. file:'${file}'`)
        }
    }));

    await Promise.allSettled(Array.from(compilationSets).map(compilation=>compilation.createCompleted()));

    const compilations = Array.from(compilationSets);
    const getAssets=(graph)=>{
        let result = [];
        if(graph.assets){
            result.push(...graph.assets);
        }
        if(!graph.children)return result;
        result.push(...Array.from(graph.children.values()).map(child=>getAssets(child)).flat())
        return result;
    }
    
    await Promise.allSettled(pluginInstances.map( async(plugin)=>{
        const assets = new Set();
        const bundle = plugin.options.bundle || {};
        await callAsyncSequence(compilations, async(compilation)=>{
            await compilation.ready();
            const graph = await plugin.run(compilation);
            if(graph){
                if(bundle.enable){
                    getAssets(graph).forEach(asset=>{
                        assets.add(asset);
                    })
                }
            }
        });
        if(bundle.enable){
            await buildAssets(plugin, assets);
        }
    }));

    if(escOptions.watch && compile.fsWatcher){
        compile.fsWatcher.on('change', async(change)=>{
            const file = compile.normalizePath(change);
            if(assetsRecords.has(file)){
                const [asset, options] = assetsRecords.get(file);
                if(asset){
                    await buildAsset(asset, options);
                }
            }else{
                const compilation = compile.getCompilation(file);
                if(compilation && !compilation.isValid()){
                    compilation.clear();
                    await compilation.ready();
                    await Promise.allSettled(pluginInstances.map( async(plugin)=>{
                        await plugin.build(compilation);
                    }));
                }else{
                    return;
                }
            }
            console.info(`[ESC] ${file} changed`)
        });
    }
    
    if(escOptions.emitTypes){
        const deps = new Set();
        const cache = new WeakSet();
        const getDeps = (compilation)=>{
            if(cache.has(compilation))return;
            cache.add(compilation);
            if(!/[\\\/]node_modules[\\\/]/.test(String(compilation.file))){
                deps.add(compilation);
                compilation.getCompilationsOfDependency().forEach(getDeps)
            }
        }
        {
            compilationSets.forEach(getDeps);
        }
        const types = new Map();
        deps.forEach( compi=>{
            types.set(compi, null);
        });
        await makeTyping(types, outdir, compile);
    }

    if(escOptions.watch){
        console.info('[ESC] Starting compilation in watch mode...')
    }else{
        const errors = compile.errors.filter(e=>e.kind<2);
        if(errors.length>0){
            console.info(`\n[ESC] Build done. but found ${errors.length} errors`)
        }else{
            console.info(`\n[ESC] Build done.`)
        }
        console.info(`\n[ESC] Output ${outdir}\n`)
    }
}

async function bundle(compile, escOptions, files){
    const plugins = (escOptions.plugins || []).slice(0);
    const output = escOptions.output;
    plugins.unshift( loader(compile, compile.options.plugins || [], escOptions) );
    const splitting = escOptions.splitting === false ? false : (escOptions.splitting ? true : files.length>1)
    const esbuildOptions = {
        entryPoints:files,
        entryNames:escOptions.entryNames || '[name]',
        chunkNames:escOptions.chunkNames || 'deps/[hash]',
        splitting:splitting,
        bundle: escOptions.bundle,
        outdir: output,
        format: escOptions.format || 'esm',
        platform: escOptions.platform || 'node',
        metafile:true,
        loader:escOptions.loaders,
        treeShaking:escOptions.treeShaking,
        nodePaths:escOptions.resolve.paths,
        minify:escOptions.minify,
        sourcemap:!!escOptions.sourcemap,
        resolveExtensions:escOptions.resolve.extensions,
        define:escOptions.define,
        external:escOptions.externals || [],
        plugins,
    };

    if(escOptions.watch){
        esbuild.context(esbuildOptions).then( async ctx=>{
            await ctx.watch();
            console.info('[ESC] Starting compilation in watch mode...')
        }).catch(e=>{
            console.error( e )
        });
    }else{
        esbuild.build(esbuildOptions).then( res=>{
            if(res.errors.length>0){
                console.info(`[ESC] Build done. but found ${res.errors.length} errors`)
            }else{
                console.info('\n[ESC] Build done.')
            }
            console.info(`\n[ESC] Output: ${output}\n`)
        }).catch(e=>{
            console.error(e)
        });
    }
}

module.exports = async(options)=>{
    let files = options.file;
    const compilerOptions = {
        diagnose:true,
        watch:false,
        enableComments:true,
        lang:'zh-CN',
        configFileName:null,
        suffix:null,
        workspace:null,
        reserved:null,
        throwError:null,
        types:null,
        mode:null,
    }

    Object.keys(compilerOptions).forEach(key=>{
        if( options[key] ){
            compilerOptions[key] = options[key];
        }else if(compilerOptions[key]===null){
            delete compilerOptions[key];
        }
    });

    let escOptions = {};
    escOptions.define = {
        'process.env.NODE_ENV':`"${options.mode}"`
    };

    compilerOptions.esc = escOptions;
    Object.keys(options).forEach( key=>{
        if(!Object.prototype.hasOwnProperty.call(compilerOptions, key)){
            escOptions[key] = options[key];
        }
    });

    const compile = new Compiler(compilerOptions);
    escOptions = compile.options.esc;
    escOptions.watch = compilerOptions.watch;
    escOptions.emitTypes = !!options.emitTypes;

    if(!compile.options.plugins.length){
        throw new ReferenceError('Not found plugins.')
    }

    if(!escOptions.output){
        escOptions.output = compile.options.output || 'build';
        const clients = ['es-vue','es-javascript','es-nuxt','es-uniapp']
        const client = compile.options.plugins.find(plugin=>clients.includes(plugin.name))
        if(client && client.options.output){
            escOptions.output = client.options.output;
        }
    }

    if(escOptions.output && !path.isAbsolute(escOptions.output)){
        escOptions.output = path.join(compile.options.cwd, escOptions.output);
    }

    if(!files && compile.options.input){
        files = compile.options.input;
    }

    if(files && !Array.isArray(files)){
        files = [files];
    }
    
    if(files){
        files = files.map( file=>{
            if(!path.isAbsolute(file)){
                file = path.join(compile.workspace, file)
            }
            if(!fs.existsSync(file))return [];
            if(fs.statSync(file).isDirectory()){
                const dir = file;
                const files = [];
                fs.readdirSync(dir).forEach( file=>{
                    if(file==='.' || file==='..')return false;
                    file = path.join(dir,file);
                    if(fs.statSync(file).isFile() && file.endsWith(compile.options.suffix)){
                        files.push(file);
                    }
                });
                return files;
            }else if(file.endsWith(compile.options.suffix)){
                return [file];
            }
            return []
        }).flat();
    }else{
        const tries = ['App.es','Index.es','app.es','index.es'].map( name=> path.join(compile.workspace, name) )
        const result = tries.find(file=>fs.existsSync(file))
        if(result){
            files =[result];
        }else{
            throw new ReferenceError('Not found entry file.')
        }
    }

    if(!files.length){
        throw new ReferenceError('Not found entry files')
    }

    if(options.clear){
        fs.emptyDirSync(escOptions.output);
    }
    if(!hasClientPlugin(compile.options.plugins)){
        builder(compile, escOptions, files);
    }else{
        bundle(compile, escOptions, files);
    } 
}