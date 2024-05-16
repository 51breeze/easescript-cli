
const esbuild = require('esbuild');
const loader = require('./loader');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs-extra');
const {makeTyping} = require('./make');
const Compiler = require('easescript/lib/core/Compiler');
const chokidar = require("chokidar");
function formatMessage(outdir){
    let message = [
        'Build successful!',
        `Output:${outdir}`
    ];

    let strLen = 0;
    let hideMaxLen = 0;
    let hideChars = ['\x1B[31m','\x1B[39m'];
    message.forEach( item=>{
        let len = 0;
        hideChars.forEach( match=>{
            if( item.includes(match) ){
                len+=match.length;
            }
        });
        if(len>0){
            hideMaxLen = Math.max(len, hideMaxLen);
        }
        strLen = Math.max(strLen, item.length);
    });

    let sep =  '*'.repeat(strLen-hideMaxLen+10);
    let format = ()=>{
        let padding = '   ';
        return message.map( item=>{
            item = item.padEnd(strLen-(padding.length*2)-4);
            item = padding+item+padding;
            item = sep.slice(0,2) +item + sep.slice(-2);
            return item;
        }).join('\n');
    }
    console.info(chalk.green(`${sep}\n${format()}\n${sep}`))
}

function hasClientPlugin(plugins){
    return plugins.some( plugin=>{
        return ['es-vue','es-javascript','es-nuxt','es-uniapp'].includes( plugin.name );
    });
}

const newPluginInstance=(compile, config={})=>{
    const load = ()=>{
        if(config.plugin && typeof config.plugin==='function'){
            return config.plugin;
        }else if(config.name){
            return require(config.name)
        }else{
            throw new Error('Plugin name invalid')
        }
    }
    const builder = load();
    return new builder(compile, config.options)
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
        return {
            entryPoints:[file],
            outdir: output,
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

    const pluginInstances = plugins.map(config=>{
        const options = config.options || (config.options={});
        options.emitFile=true;
        if(outdir)options.output = outdir;
        return newPluginInstance(compile, config)
    });


    const fileAssets = [];
    if(escOptions.watch && compile.fsWatcher){
        compile.fsWatcher.on('change', async(change)=>{
            const file = compile.normalizePath(change);
            if(!fileAssets.includes(file)){
                await Promise.allSettled(pluginInstances.map( async(plugin)=>{
                    const compilation = compile.getCompilation(file);
                    if(compilation){
                        await compilation.ready();
                        await plugin.build(compilation);
                        await makeTyping(new Map([[compilation,null]]), outdir);
                        console.log('---------', file )
                    }
                }))
            }
        });
    }

    const compilations= new Set();
    await Promise.allSettled(files.map(async file=>{
        const compilation = await compile.createCompilation(file);
        if(compilation){
            compilation.createStack();
            compilations.add(compilation)
        }else{
            console.error(`Not resolved compilation. file:'${file}'`)
        }
    }));

    await Promise.allSettled(Array.from(compilations).map(compilation=>compilation.createCompleted()));
    await Promise.allSettled(pluginInstances.map( async(plugin)=>{
        await plugin.batch(Array.from(compilations));
        const bundle = plugin.options.bundle;
        if(bundle.enable){
            const Assets = plugin.getVirtualModule('asset.Assets');
            if(Assets.using){
                const buildAssets = async ()=>{
                    const assets = plugin.getAssets().filter(asset=>bundle.extensions.includes(asset.getExt()));
                    await Promise.allSettled(assets.map( async (asset)=>{
                        const file = asset.getAssetFilePath();
                        fileAssets.push(file);
                        const options = getEsBuildOptions(file, asset.getOutputDir(), plugin.options.bundle)
                        const build = async ()=>{
                            const result = await esbuild.build(options);
                            const outputs = result.metafile.outputs;
                            Object.keys(outputs).forEach( dist=>{
                                const item = outputs[dist];
                                if(file.includes(item.entryPoint)){
                                    asset.unlink();
                                    asset.dist = compile.normalizePath(path.relative(asset.getBaseDir(), dist));
                                }
                            });
                        }

                        await build();
                        if(escOptions.watch && compile.fsWatcher){
                            compile.fsWatcher.on('change', async(change)=>{
                                if(compile.normalizePath(change) === file){
                                    await build();
                                }
                            });
                        }
                       
                    }));
                }
                await buildAssets();
                await Assets.make();
            }
        }

    }));

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
        compilations.forEach(getDeps);
    }

    const types = new Map();
    deps.forEach( compi=>{
        types.set(compi, null);
    });
    await makeTyping(types, outdir);

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

    fs.emptyDirSync(escOptions.output);

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

    if(!hasClientPlugin(compile.options.plugins)){
        builder(compile, escOptions, files);
    }else{
        bundle(compile, escOptions, files);
    } 
}